# 远端串口链路协议 v0（定稿）

> 状态：**v0 已定稿**。host 侧 `tcp` 适配器、假桥与 ESP32-S3 固件（`serial-hub-bridge`）
> 已实现；`udp/kcp/mqtt/ws` 与压缩为 v1 备选。
> 架构背景见 [hub-architecture.md](./hub-architecture.md)。

本文是 host（serial-hub-mcp）与远端串口桥（ESP32-S3 等）之间的**唯一事实源**。
v0 只定义 host 发起、设备应答的 pull 模型；设备**不主动推**。

## 0. 决策摘要

| # | 决策 | 结论 |
|---|---|---|
| 1 | v0 帧格式 | **NDJSON**（一行一个 JSON，`\n` 结束），二进制用 base64 |
| 2 | 传输落地顺序 | `tcp` → `ws` → `udp/kcp/mqtt`（后三者需满足第 10 节的可靠性约束） |
| 3 | 计数器 | `rx_offset` / `tx_offset`（字节绝对偏移）+ `log_seq`（日志条目序号），三者独立 |
| 4 | 长轮询 | `max_wait_ms` 默认 5000，设备硬上限 `caps.max_hold_ms`（默认 10000），超出被 clamp 并回 `hold_clamped:true` |
| 5 | gap / 重连 | `from_offset < ring_start_offset` → `gap=true`；重连无会话，host 用同一 `from_offset` 幂等重试 |
| 6 | 鉴权 | 首帧 `HELLO.token`；v0 明文，仅信任网络（建议 VPN/SSH 隧道），`tls` 预留 |
| 7 | 能力位 | `HELLO/INFO` 返回 `caps`，见第 5 节 |
| 8 | 版本 | `proto:"v0"`；未知字段必须忽略，便于增量演进 |

## 1. 传输与帧

- **v0 传输**：TCP（默认端口由部署决定，示例用 7000）。后续 `ws/udp/kcp/mqtt` 复用同一套 JSON 报文。
- **帧格式**：NDJSON —— UTF-8 文本，一行一个完整 JSON 对象，`\n` 结束。
- **二进制**：一律 base64（字段名以 `_b64` 结尾）。
- **帧上限**：`caps.max_frame`（默认 65536 字节 JSON 行）。超限设备直接关闭连接并记录错误。
- **并发**：每条链路**同一时刻最多一个 in-flight 请求**（host 已按 `connection_id` 串行）。设备对并发请求回 `busy`。
- **保活**：空闲 10s 后 host 发 `PING`，设备回 `PONG`；TCP keepalive 建议开启。

请求 / 应答外壳：

```json
{"id": 7, "op": "READ", "port": "uart0", "...": "..."}
{"id": 7, "ok": true,  "result": { "...": "..." }}
{"id": 7, "ok": false, "error": {"code": "ring_gap", "message": "from_offset < ring_start_offset"}}
```

- `id`：每条连接内单调递增（host 生成），应答原样回显。
- `op`：操作名，见第 7/8 节。
- 设备**不得**发送非应答帧（v0 无事件/推送）。

## 2. 会话状态机

```
TCP connect
   │
   ▼
HELLO（鉴权 + 协议版本 + 能力）
   │  ok
   ▼
READY ── CONFIG/WRITE/READ/TRANSACT/SET_LINES/BREAK/LOG_* /PING
   │
   ├─ CLOSE / TCP FIN / 超时 ──► 释放资源（中止 held READ）
   └─ 鉴权失败/协议不匹配 ──► 回 error 后关闭连接
```

- `HELLO` **必须**是首帧；未收到前其它请求回 `unauthorized` 并关闭。
- 设备不保存「订阅状态」；游标由 host 每次请求携带，因此断线重连无需会话恢复。
- host 关闭连接时，设备应停止任何仍在等待的 `READ`。

## 3. 鉴权

```json
{"id":1,"op":"HELLO","proto":"v0","token":"<token>","client":"serial-hub-mcp/0.1.0"}
{"id":1,"ok":true,"result":{"proto":"v0","fw_version":"0.1.0","caps":{...},"ports":[...]}}
```

- 设备侧 token 由部署配置（不在协议里下发）。比较使用常量时间。
- 设备首次启动会生成 16 字节随机 token 存入 NVS（或由 `CONFIG_BRIDGE_AUTH_TOKEN` 覆盖），
  `caps.auth=true`；token 打印在串口启动日志，配网 QR 也带 `token` 字段。
- 鉴权失败：回 `{"code":"unauthorized"}` 并关闭；建议设备做失败次数限制。
- **v0 不加密**。跨不可信网络必须走 VPN/SSH 隧道；`tls://` scheme 预留给后续。

## 4. 计数器（不要混用）

| 计数器 | 含义 | 用途 |
|---|---|---|
| `rx_offset` | 端口 RX 的**绝对字节偏移**（uint64） | `READ.from_offset`、`TRANSACT.barrier_offset`、`gap` |
| `tx_offset` | 端口 TX 的**绝对字节偏移**（uint64） | `WRITE` 结果、TX 日志条目定位 |
| `log_seq` | 端口**日志条目**序号（RX 一行一条、TX 一次写一条） | `LOG_QUERY` 游标、`earliest_seq` |

- host 必须把三者当作**不透明单调整数**（JS 安全上限 2^53，足够）。
- **`offset` 是字节游标，`log_seq` 是条目游标，二者不可互换。**
- `rx_offset`/`tx_offset` 采用 **0-based 位置语义**：`rx_offset` 表示「已收到的字节数」，
  下一个到达字节的位置就是该值；`READ.from_offset = N` 返回位置 `>= N` 的字节。
  因此 `TRANSACT` 的 `offset_from = barrier_offset`（不是 `+1`）。

## 5. 能力协商

`HELLO.result` 与 `INFO.result` 形状一致：

```json
{
  "proto": "v0",
  "fw_version": "0.1.0",
  "board": "esp32s3",
  "ports": [
    {"id": "uart0", "kind": "uart", "pins": {"tx": 17, "rx": 18}}
  ],
  "caps": {
    "auth": true,
    "has_sd": true,
    "sd_free_bytes": 32212254720,
    "log_capacity_bytes": 21474836480,
    "ring_bytes": 262144,
    "max_hold_ms": 10000,
    "max_frame": 65536,
    "can_set_lines": true,
    "can_break": true,
    "can_config": true,
    "log_filter": ["seq", "dir"],
    "log_storage": "raw+index",
    "binary_frames": false
  },
  "time": {"epoch_ms": 1760000000000, "synced": true, "source": "ntp", "tick_ms": 123456789}
}
```

- `port` 字段在设备只有**一个**端口时可省略，设备默认到该端口；多端口时必须显式给出。
- `can_set_lines=false` 时 host 必须拒绝 `set_dtr_rts`（ESP32-S3 原生 USB-JTAG 即属此类）。
- `log_filter` 表示设备可直接下推的过滤维度；`contains/regex` 不在列表时由 host 拉取后本地过滤。
- `binary_frames` 为 v1 预留；v0 必须为 `false`，host 不得发送二进制帧。

## 6. 串口生命周期

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

### LIST_PORTS（等价于 INFO.ports，便于单独查询）

```json
{"id":4,"op":"LIST_PORTS"}
→ {"id":4,"ok":true,"result":{"ports":[{"id":"uart0","kind":"uart","caps":{...}}]}}
```

## 7. 数据面 RPC

### WRITE（只发不收）

```json
{"id":10,"op":"WRITE","port":"uart0","data_b64":"QVRJ","op_id":"w-7f3a"}
→ {"id":10,"ok":true,"result":{"bytes_written":3,"tx_offset":900,"tx_log_seq":44,"deduped":false}}
```

- 语义：字节写入 UART 后返回（不等待应答）。
- **顺序**：分配 `tx_offset` → 落 SD 日志 → 写 UART。
- `op_id` 可选：设备用小型 LRU（建议 64 条 / 60s）做去重；重复请求返回首次结果且 `deduped:true`。
- 设备重启后去重缓存丢失，WRITE 语义为 **at-least-once**（host 不得盲目重试）。

### READ（带等待的 pull / long-poll）

```json
{
  "id":11,"op":"READ","port":"uart0",
  "from_offset":1000,
  "match_b64":"",
  "min_bytes":1,
  "max_wait_ms":5000,
  "idle_timeout_ms":300,
  "budget_ms":10000,
  "max_bytes":null
}
→ {
  "id":11,"ok":true,
  "result":{
    "data_b64":"...",
    "offset_from":1000,"offset_to":1013,"next_offset":1013,
    "matched":false,"stopped_reason":"idle",
    "gap":false,"ring_start_offset":980,"ring_end_offset":1013,
    "hold_clamped":false
  }
}
```

结束条件优先级（与本地一致）：`match > max_bytes > idle > budget`。

- `stopped_reason`: `match | max_bytes | min_bytes | idle | budget | closed | error`
  （`min_bytes` 表示满足最小字节数后立即返回，属于正常部分结果，不是超时）
- `max_wait_ms` 超过 `caps.max_hold_ms` 时设备 **clamp** 并回 `hold_clamped:true`。
- **`gap=true`**：`from_offset < ring_start_offset`，返回从 `ring_start_offset` 起的数据，
  host 应改用 `LOG_EXPORT` 从 SD 补齐。
- **幂等**：响应丢失/超时后，host 用同一个 `from_offset` 重发即可（设备只读不消耗）。

### TRANSACT（写 + 屏障 + 等响应，单次往返）

```json
{"id":12,"op":"TRANSACT","port":"uart0","data_b64":"QVRJKzENCg==","op_id":"t-91c2",
 "match_b64":"T0s=","min_bytes":1,"max_wait_ms":2000,"idle_timeout_ms":200,"budget_ms":5000}
→ {"id":12,"ok":true,"result":{
  "data_b64":"...","offset_from":1013,"offset_to":1020,"next_offset":1020,
  "barrier_offset":1013,
  "tx_offset":903,"tx_log_seq":45,
  "matched":true,"stopped_reason":"match","gap":false,"deduped":false
}}
```

**屏障语义**：`offset_from = barrier_offset`（0-based），只返回「写之后到达」的字节。
这是本地 `base = _length` 的远端等价物，避免 RTT 期间设备主动吐出的字节被误算为响应。
host **不得**用 `WRITE` + `READ` 两次往返自己拼，否则屏障不精确。

### SET_LINES / BREAK

```json
{"id":20,"op":"SET_LINES","port":"uart0","dtr":true,"rts":false}
→ {"id":20,"ok":true,"result":{"dtr":true,"rts":false}}

{"id":21,"op":"BREAK","port":"uart0","duration_ms":300}
→ {"id":21,"ok":true,"result":{"duration_ms":300}}
```

- 需要 `caps.can_set_lines` / `caps.can_break`，否则回 `unsupported`。
- 时序敏感操作（目标 EN/BOOT）建议固件内一次 RPC 完成整段时序。

### PING / PONG

```json
{"id":90,"op":"PING","t_ms":1760000000123}
→ {"id":90,"ok":true,"result":{"t_ms":1760000000123,"device_tick_ms":123456789}}
```

## 8. 日志 RPC（设备权威）

### LOG_QUERY

```json
{"id":30,"op":"LOG_QUERY","port":"uart0","dir":"rx",
 "seq_from":100,"seq_to":null,"time_from":null,"time_to":null,
 "contains":null,"regex":null,"cursor":null,"limit":100}
→ {"id":30,"ok":true,"result":{
  "entries":[{"seq":123,"ts":1760000000123,"dir":"rx","offset":1000,
              "line":"OK","hex":"4f4b","bytes":2}],
  "count":1,"truncated":false,"next_cursor":"123","earliest_seq":100,
  "ram_earliest_seq":100,"ram_latest_seq":123,"ram_count":24,
  "sd_earliest_seq":1,"sd_latest_seq":4567,
  "retention":{"capacity_bytes":21474836480,"used_bytes":1048576,"evicted_lines":null},
  "source":"device","authoritative":true,"time_source":"tick"
}}
```

- 设备保证支持 `seq/dir` 与游标分页（`cursor` → `next_cursor`）；`time` 暂不支持
  （设备当前只有 uptime tick）。
- `contains/regex` 不在 `caps.log_filter` 内，host 分页拉取后本地过滤（有页数上限）。
- `earliest_seq` 是 RAM 窗口起点；响应另带 `ram_earliest_seq/ram_latest_seq` 与
  `sd_earliest_seq/sd_latest_seq`，三者不可混用。
- 跨源查询由 hub 按 `connection_id` 分块，**不按 seq 归并**。

### LOG_STATS

```json
{"id":31,"op":"LOG_STATS","port":"uart0"}
→ {"id":31,"ok":true,"result":{
  "capacity_bytes":21474836480,"used_bytes":1048576,
  "earliest_seq":100,"latest_seq":4567,
  "ram_earliest_seq":4500,"ram_latest_seq":4567,"ram_count":68,
  "sd_earliest_seq":100,"sd_latest_seq":4567,"global_latest_seq":4567,
  "segment":"00000000-82de",
  "segments":[{"id":"00000000-82de","raw_bytes":1048576,"index_count":4467,
               "first_seq":100,"latest_seq":4567,"active":true}],
  "ring":{"bytes":4194304,"used":1024,"start_offset":980,"end_offset":1013,"dropped_bytes":0},
  "time":{"synced":false,"source":"tick"}
}}
```

### LOG_CLEAR

```json
{"id":32,"op":"LOG_CLEAR","port":"uart0"}
→ {"id":32,"ok":true,"result":{"cleared":true,"sd_cleared":true,"ram_cleared":true,
                                "active_cleared":true}}

{"id":32,"op":"LOG_CLEAR","port":"uart0","segment":"00000000-82de"}
→ {"id":32,"ok":true,"result":{"cleared":true,"sd_cleared":true,"ram_cleared":false,
                                "active_cleared":false,"segment":"00000000-82de"}}
```
- 省略 `segment`（或 `"all"`/`"*"`）清空所有 segment，并把 seq 归零；指定 segment 只清该段。

### LOG_EXPORT（按段导出原始字节 + 索引，host 侧还原条目）

```json
{"id":33,"op":"LOG_EXPORT","port":"uart0","dir":"rx",
 "segment":"00000000-82de","seq_from":100,"seq_to":null,"time_from":null,"time_to":null,
 "cursor":null,"max_bytes":65536}
→ {"id":33,"ok":true,"result":{
  "chunk_b64":"...",
  "index_b64":"...",
  "segment":"00000000-82de",
  "bytes":65536,"next_cursor":"...","eof":false
}}
```

- `index_b64` 解码后是索引记录（建议定长）：`{offset, seq, tick_ms, dir}`；`offset` 是
  **segment 内**偏移。`segment` 省略时导出当前活动段。
- host 用与本地**相同**的切行器把 `chunk + index` 还原成条目 schema。
- 大流量/历史导出走这里；`max_bytes` 建议 16–64 KiB（受 `caps.max_frame` 约束）。

## 9. 错误码与重试

| code | 含义 | host 行为 |
|---|---|---|
| `bad_request` | 参数缺失/非法 | 报错，不重试 |
| `unknown_op` | 不支持的操作 | 报错 |
| `unauthorized` | 鉴权失败/未 HELLO | 报错，连接被关闭 |
| `port_not_found` / `not_open` | 端口不存在/未 CONFIG | 报错 |
| `unsupported` | 能力不支持 | 报错并提示 `caps` |
| `busy` | 已有 in-flight | 按 `retry_after_ms` 重试 |
| `ring_gap` | READ 追上界丢失区 | 标记 `gap`，转 `LOG_EXPORT` |
| `io_error` | UART/SD IO 失败 | 报错，可重试 |
| `frame_too_large` | 超过 `max_frame` | 报错，连接可能被关闭 |
| `not_impl` | 预留未实现 | 报错 |

- 无 `retry_after_ms` 时建议指数退避（1s 起，上限 5s）。
- 除 `WRITE/TRANSACT` 外，所有请求都应可安全重试；`WRITE/TRANSACT` 依赖 `op_id` 去重。

## 10. 重连、顺序与可靠性

- **无会话**：重连后重新 `HELLO`；`READ` 从 host 记录的 `next_offset` 续拉。
- **顺序**：单连接内 host 不 pipeline（v0 一个 in-flight）；设备按请求顺序处理。
- **`tcp`/`ws`**：依赖传输的顺序与可靠；仍需 `gap` 检测（ring 会回绕）。
- **`udp`/`kcp`/`mqtt(QoS0)`**：传输层不保证顺序/不丢，适配层必须提供：
  - 请求-应答相关性（`id` / MQTT topic + `id`）
  - 重试与 `op_id` 去重
  - `READ` 的 `from_offset` 幂等
  - `gap` 语义不得被吞掉
- **MQTT 建议**：request topic + response topic，QoS ≥ 1；`id` 关联。
- **WRITE/TRANSACT 语义**：跨设备重启为 at-least-once（去重缓存会丢），host 不得盲目重试。

## 11. 背压

- 设备 RAM ring 满时丢最旧，并在 `READ/LOG_STATS.ring.dropped_bytes` 暴露计数。
- `READ` 的 `ring_start_offset` / `end_offset` 让 host 判断是否追丢。
- v0 不引入显式窗口/流控；靠「短窗口高频 pull」+ SD 历史导出。
- 设备可回 `busy` + `retry_after_ms` 表达暂时不可服务。

## 12. v1 预留（不实现，仅占位）

- `caps.binary_frames=true`：`READ/LOG_EXPORT` 可返回原始二进制帧（省 base64）。
- `tls://` scheme 与证书/指纹配置。
- 数据压缩（**默认关闭，协商启用**）：`caps.compression = ["none","lz4","heatshrink"]`；
  按块自适应（块 ≥ 1–4KB 且压缩后 < 原始 95% 才置 `COMPRESSED`），
  `LOG_EXPORT` 优先，交互路径默认不压。文本日志通常可省 50–70%，随机/已压缩数据无收益。
- 设备主动推流（当前明确非目标）。
- 多 host 共享同一设备（仍以无会话 + 游标在请求里为前提）。

## 13. 完整交互示例

```
C: {"id":1,"op":"HELLO","proto":"v0","token":"s3cr3t","client":"serial-hub-mcp/0.1.0"}
S: {"id":1,"ok":true,"result":{"proto":"v0","fw_version":"0.1.0","caps":{"max_hold_ms":10000,"can_set_lines":true,...},"ports":[{"id":"uart0"}]}}
C: {"id":2,"op":"CONFIG","port":"uart0","baud_rate":115200,"data_bits":8,"stop_bits":1,"parity":"none","flow_control":"none"}
S: {"id":2,"ok":true,"result":{"port":"uart0","applied":{...}}}
C: {"id":3,"op":"TRANSACT","port":"uart0","data_b64":"QVRJKzENCg==","op_id":"t-1","match_b64":"T0s=","budget_ms":5000}
S: {"id":3,"ok":true,"result":{"data_b64":"T0sNCg==","offset_from":0,"offset_to":4,"next_offset":4,"barrier_offset":0,"matched":true,...}}
C: {"id":4,"op":"READ","port":"uart0","from_offset":4,"budget_ms":10000,"idle_timeout_ms":300}
S: {"id":4,"ok":true,"result":{"data_b64":"","offset_from":4,"offset_to":4,"next_offset":4,"stopped_reason":"idle","gap":false,...}}
C: {"id":5,"op":"CLOSE","port":"uart0"}
S: {"id":5,"ok":true,"result":{"port":"uart0","closed":true}}
```

## 附录 A：容量与性能基线（估算）

用于选 `ring_bytes` / `max_bytes` / `max_frame`、规划 SD 容量，以及判断某种传输是否可行。

### A.1 计算口径

- UART **8N1 = 10 bit/byte**（若 8E1 则 11 bit/byte，原始字节数约再少 9%）。
- 原始字节率 `raw = baud / 10`（B/s）。
- NDJSON + base64：`wire ≈ raw × 4/3 + (raw / chunk) × 200B`（每帧约 200B JSON 信封）。
- 日志索引按 **12 B/条**；行均长度 L 时索引开销约 `12 / L`。
- 以下为**连续满速**假设；实际有 idle/流控时会低于估算。

### A.2 吞吐与网络

| baud | 原始 B/s | 原始 KiB/s | NDJSON+b64 KiB/s | 线上 Mbps | 16K 块间隔 |
|---|---|---|---|---|---|
| 115,200 | 11,520 | 11.3 | **15.1** | **0.12** | 1.42 s |
| 921,600 | 92,160 | 90.0 | **121** | **0.99** | 0.18 s |
| 1,500,000 | 150,000 | 146.5 | **197** | **1.61** | 0.11 s |

判断：

- **115200**：BLE 都够（~15 KiB/s 线上）。
- **921600**：必须 WiFi；~1 Mbps，2.4G 可用但建议 5G/良好信号；BLE 不建议。
- **1500000**：~1.6 Mbps 应用层，WiFi 5G 推荐；2.4G 拥塞时偏紧。ESP32 同时做
  base64 + JSON + TCP + UART + SD 会吃 CPU，连续流建议后续上 v1 二进制帧（省 33% 带宽与编码开销）。

### A.3 设备日志容量（SD）

原始字节，不含索引：

| baud | MB/小时 | GB/天 | 32GB 卡 | 128GB 卡 |
|---|---|---|---|---|
| 115,200 | 41 | 1.0 | ~32 天 | ~128 天 |
| 921,600 | 332 | 7.96 | ~4 天 | ~16 天 |
| 1,500,000 | 540 | 12.96 | ~2.5 天 | ~10 天 |

索引按 12 B/条：

| baud | 行均 20B | 60B | 120B | 60B 行时 GB/天（含索引） |
|---|---|---|---|---|
| 115,200 | +60% | +20% | +10% | 1.19 |
| 921,600 | +60% | +20% | +10% | 9.56 |
| 1,500,000 | +60% | +20% | +10% | 15.55 |

- 1.5M 连续采集约 **13–16 GB/天**；128GB 卡约 **1 周多**，32GB 卡约 **2 天**。
- 短行文本日志索引开销大（20B 行 +60%）。高码率建议**按块索引**（如每 64KB 一条）而非逐行。

### A.4 Ring 覆盖时长（host 卡顿容忍）

| baud | 64KB | 256KB | 1MB | 4MB |
|---|---|---|---|---|
| 115,200 | 5.7s | 22.8s | 91s | 364s |
| 921,600 | 0.71s | 2.8s | 11.4s | 45s |
| 1,500,000 | 0.44s | 1.7s | 7.0s | 28s |

关键：**READ 必须持续被 drain**。host 停顿（agent 思考、GC）超过 ring 覆盖时间就会 `gap`。
921600 建议 ring ≥ 256–512KB；1500000 有 PSRAM 时上 1MB，否则接受偶发 `gap` 并靠 `LOG_EXPORT` 补齐。

### A.5 MCP 层放大（不要用 read/receive 拉大块）

`read` / `receive` 的结果同时返回 `text` 与 `hex`，`hex` 是 **2×**，因此
**N 字节原始数据 → MCP 响应约 3N**（再加 JSON 转义）：

- 16 KiB 原始 → 约 48 KiB 文本，容易撑爆 agent 上下文。
- 1.5M 跑 15s 的 `receive` 会攒 ~2.25 MB，无法通过 MCP 返回。

因此：

- 实时查看：小 `max_bytes`（4–16 KiB）+ 短窗口。
- 长日志：设备 SD 权威日志 + `LOG_QUERY` 分页 / `LOG_EXPORT` 落盘。
- host 侧实时落盘：`dump_to_file`（只回预览，不搬大字节）。

### A.6 推荐默认（按 baud）

| 参数 | 115200 | 921600 | 1500000 |
|---|---|---|---|
| `READ.max_bytes` | 8–16 KiB | 16–32 KiB | 32 KiB（≤~45KB，受 `max_frame`） |
| `caps.max_frame` | 64 KiB | 64 KiB | **128 KiB**（或 raw chunk ≤45KB） |
| `ring_bytes` | 64–128 KiB | 256–512 KiB | **1 MiB（PSRAM）** |
| `max_hold_ms` | 10000 | 5000 | 2000–5000（空闲可长，但 ring 要够） |
| 传输 | BLE/WiFi 均可 | WiFi | WiFi 5G，优先 v1 二进制帧 |
| 日志索引 | 逐行可 | 逐行/块 | **按块（64KB）** |

### A.7 结论

- **115200**：无压力，NDJSON/base64 足够。
- **921600**：可行，重点盯 ring 大小与 host drain 节奏，网络 ~1 Mbps。
- **1500000**：带宽 ~1.6 Mbps 不是瓶颈，瓶颈在 ESP32 的 **base64/JSON、SD 写入、ring 覆盖**；
  建议 PSRAM ring + 块索引，并优先推进 v1 二进制帧。
