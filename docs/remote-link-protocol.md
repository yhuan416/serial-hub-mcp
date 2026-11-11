# 远端串口链路契约（host ↔ ESP32-S3 桥）

> 状态：契约草案。MCP 侧已留 `transport=remote` 接缝（当前明确报「尚未实现」）。
> 架构背景见 [hub-architecture.md](./hub-architecture.md)。

## 1. 传输与帧

- **传输**：TCP（推荐）或 WebSocket。BLE 吞吐不足，仅作兜底。
- **帧**：NDJSON —— 一行一个 JSON 对象，`\n` 结束。二进制一律 base64。
- **方向**：所有 RPC 由 **host 发起**，设备只应答，**不主动推**。
- **并发**：建议每条链路同一时刻只有一个 in-flight 请求（hub 已按 `connection_id` 串行）。
- **保活**：空闲时 host 每 10s 发 `PING`；或依赖 TCP keepalive。
- **帧上限**：`caps.max_frame`（建议 64 KiB 原始字节；base64 后约 88 KiB）。

请求/应答外壳：

```json
{"id": 7, "op": "READ", "port": "uart0", "...": "..."}
{"id": 7, "ok": true,  "result": { "...": "..." }}
{"id": 7, "ok": false, "error": {"code": "ring_gap", "message": "from_offset < ring_start_offset"}}
```

## 2. 两个计数器（不要混用）

| 计数器 | 含义 | 用途 |
|---|---|---|
| `offset` | 端口 RX/TX 的**绝对字节偏移**（uint64，环形缓冲按绝对偏移记账） | `READ` 游标、`TRANSACT` 屏障、`gap` 判定 |
| `log_seq` | 端口**日志条目**的单调序号（RX 一行一条、TX 一次写一条） | `LOG_QUERY` 游标、`earliest_seq` |

> 设备侧日志权威；hub 不改号。`offset` 用于「拉哪一段字节」，`log_seq` 用于「查哪几条日志」。

## 3. 能力协商

`INFO` 是 host `open` 后的第一条请求：

```json
// req
{"id":1,"op":"INFO"}
// res
{
  "id":1,"ok":true,
  "result":{
    "fw_version":"0.1.0",
    "board":"esp32s3",
    "ports":[{"id":"uart0","kind":"uart","pins":{"tx":17,"rx":18}}],
    "caps":{
      "has_sd":true,"sd_free_bytes":32212254720,"log_capacity_bytes":21474836480,
      "ring_bytes":262144,"max_hold_ms":10000,"max_frame":65536,
      "can_set_lines":true,"can_break":true,"can_config":true,
      "log_filter":["seq","time","dir"],          // contains/regex 是否下发
      "log_storage":"raw+index"
    },
    "time":{"epoch_ms":1760000000000,"synced":true,"source":"ntp","tick_ms":123456789}
  }
}
```

`can_set_lines=false` 时，hub 必须拒绝 `set_dtr_rts`（ESP32-S3 原生 USB-JTAG 即属此类）。

## 4. 串口生命周期

### CONFIG（幂等，open 时调用）

```json
{"id":2,"op":"CONFIG","port":"uart0","baud_rate":115200,"data_bits":8,"stop_bits":1,"parity":"none","flow_control":"none"}
→ {"id":2,"ok":true,"result":{"port":"uart0","applied":{"baud_rate":115200,"data_bits":8,"stop_bits":1,"parity":"none","flow_control":"none"}}}
```

### CLOSE

```json
{"id":3,"op":"CLOSE","port":"uart0"}
→ {"id":3,"ok":true,"result":{"port":"uart0","closed":true}}
```

> 设计上设备近乎无状态：会话游标由 host 每次请求携带（`from_offset` / `cursor`），
> 因此断线重连不需要设备保存「谁订阅到哪」。`CONFIG` 只改 UART 参数。

## 5. 数据面 RPC

### WRITE（只发不收）

```json
// req
{"id":10,"op":"WRITE","port":"uart0","data_b64":"QVRJ..."}
// res
{"id":10,"ok":true,"result":{"bytes_written":3,"tx_offset":900,"tx_log_seq":44}}
```

语义：字节写入 UART 后返回（不等待应答）。**先分配序号 → 落 SD → 发送到 UART**，
保证日志完整且可回放。

### READ（带等待的 pull / long-poll）

```json
// req
{
  "id":11,"op":"READ","port":"uart0",
  "from_offset":1000,
  "match_b64":"",              // 可选；出现即停
  "min_bytes":1,
  "max_wait_ms":5000,          // 单次 hold 上限（建议固件硬上限 caps.max_hold_ms）
  "idle_timeout_ms":300,
  "budget_ms":10000,
  "max_bytes":null
}
// res
{
  "id":11,"ok":true,
  "result":{
    "data_b64":"...",
    "offset_from":1000,"offset_to":1013,"next_offset":1013,
    "matched":false,"stopped_reason":"idle",
    "gap":false,"ring_start_offset":980,"ring_end_offset":1013
  }
}
```

结束条件优先级与本地一致：`match > max_bytes > idle > budget`。

- `stopped_reason`: `match | max_bytes | idle | budget | closed | error`
- **`gap=true`** 表示 `from_offset < ring_start_offset`（live ring 已丢最旧）：
  返回从 `ring_start_offset` 起的数据，host 应改用 `LOG_EXPORT` 从 SD 补齐。

### TRANSACT（写 + 屏障 + 等响应，单次往返）

```json
// req
{"id":12,"op":"TRANSACT","port":"uart0","data_b64":"QVRJKzENCg==",
 "match_b64":"T0s=","min_bytes":1,"max_wait_ms":2000,"idle_timeout_ms":200,"budget_ms":5000}
// res
{"id":12,"ok":true,"result":{
  "data_b64":"...","offset_from":1014,"offset_to":1020,"next_offset":1020,
  "barrier_offset":1013,        // 设备受理写时刻的 RX 绝对偏移
  "tx_offset":903,"tx_log_seq":45,
  "matched":true,"stopped_reason":"match","gap":false
}}
```

**屏障语义**：`offset_from = barrier_offset + 1`，即只返回「写之后到达」的字节。
这是本地 `base = _length` 的远端等价物，避免 RTT 期间设备主动吐出的字节被误算为响应。
host **不要**自己用 `WRITE` + `READ` 两次往返去拼，否则屏障不精确。

### SET_LINES / BREAK

```json
{"id":20,"op":"SET_LINES","port":"uart0","dtr":true,"rts":false}
→ {"id":20,"ok":true,"result":{"dtr":true,"rts":false}}

{"id":21,"op":"BREAK","port":"uart0","duration_ms":300}
→ {"id":21,"ok":true,"result":{"duration_ms":300}}
```

时序敏感操作（目标 EN/BOOT）建议在固件内做成**一次 RPC 完成整段时序**，不要靠多次网络往返。

## 6. 日志 RPC（设备权威）

### LOG_QUERY

```json
// req
{"id":30,"op":"LOG_QUERY","port":"uart0","dir":"rx",
 "seq_from":100,"seq_to":null,
 "time_from":null,"time_to":null,
 "contains":null,"regex":null,
 "cursor":null,"limit":100}
// res
{"id":30,"ok":true,"result":{
  "entries":[{"seq":123,"ts":1760000000123,"dir":"rx","offset":1000,
              "line":"OK\r\n","hex":"4f4b0d0a","bytes":4}],
  "count":1,"truncated":false,
  "next_cursor":"123","earliest_seq":100,
  "retention":{"capacity_bytes":21474836480,"used_bytes":1048576,"evicted_lines":null},
  "source":"device","authoritative":true,
  "time_source":"ntp"
}}
```

- 设备保证支持 `seq/time/dir` 过滤与游标分页。
- `contains/regex` 若 `caps.log_filter` 未包含，则由 host 拉取后本地过滤
  （设备只按 `seq/time/dir` 圈范围）。
- 跨源查询由 hub 按 `connection_id` 分块，**不按 seq 归并**。

### LOG_STATS

```json
{"id":31,"op":"LOG_STATS","port":"uart0"}
→ {"id":31,"ok":true,"result":{
  "capacity_bytes":21474836480,"used_bytes":1048576,
  "earliest_seq":100,"latest_seq":4567,
  "ring":{"bytes":262144,"used":1024,"start_offset":980,"end_offset":1013,"dropped_bytes":0},
  "time":{"synced":true,"source":"ntp"}
}}
```

### LOG_CLEAR

```json
{"id":32,"op":"LOG_CLEAR","port":"uart0"}
→ {"id":32,"ok":true,"result":{"cleared":true}}
```

### LOG_EXPORT（按段导出原始字节，host 侧还原条目）

```json
// req
{"id":33,"op":"LOG_EXPORT","port":"uart0","dir":"rx",
 "seq_from":100,"seq_to":null,"time_from":null,"time_to":null,
 "cursor":null,"max_bytes":65536}
// res
{"id":33,"ok":true,"result":{
  "chunk_b64":"...",         // 原始字节
  "index_b64":"...",         // 索引记录：{offset, seq, tick_ms, dir}
  "bytes":65536,"next_cursor":"...","eof":false
}}
```

host 用与本地**相同**的切行器把 `chunk + index` 还原成 5.1 的条目 schema，
因此本地/远端在工具契约层完全一致。大流量走这里，不经过 `read`。

## 7. 错误码

| code | 含义 | host 行为 |
|---|---|---|
| `bad_request` | 参数缺失/非法 | 报错 |
| `unknown_op` | 不支持的操作 | 报错 |
| `port_not_found` / `not_open` | 端口不存在/未 CONFIG | 报错 |
| `busy` | 已有 in-flight（不应出现，hub 已串行） | 重试 |
| `ring_gap` | `READ` 追上界丢失区 | 标记 `gap`，转 `LOG_EXPORT` |
| `unsupported` | 能力不支持（如 `can_set_lines=false`） | 报错并提示能力位 |
| `io_error` | UART/SD IO 失败 | 报错 |
| `not_impl` | 预留未实现 | 报错 |

## 8. 非目标

- 设备主动推流 / 订阅。
- 在设备上做行切分与 JSONL 落盘（只在导出时由 host 还原）。
- 设备侧多 host 会话状态（游标在请求里）。