# 远端串口链路协议 v1

> 状态：**v1.0 字段冻结**（2026-11-13）。线格式以本文为准，并与
> `src/remote/v1_codec.js` 一致。
> 只由 host 适配器支持；新固件可以只讲 v1。
>
> 实现进度见文末 §16，**不是规范**。规范与代码冲突时，先改代码。

---

## 0. 角色

| 侧 | 职责 |
|---|---|
| **MCP / host** | 存储主力。收原始字节、按 `\n` 切行、分配日志 `seq`、落盘、检索。工具语义与 mining-serial 相同。 |
| **远端** | 发送缓存。只保留「还没被 ACK、且 MCP 还需要」的字节。不是日志库。 |

远端缓存多久**不强制**。最低义务：

- 未被 ACK 的字节不得静默丢弃。必须丢时先发 `GAP`，再前进 `oldest`。
- 已被 ACK 的字节可以立即释放。
- 缓存时长只要能满足当前 session 的窗口和一次 linger 内的 resume。
- 不要求跨重启保留。长日志靠 host 自己的缓存，不靠远端。

`HISTORY_*` 是可选附加能力。没有时必须回 `unsupported`。正确性不依赖它：host 自己手里已有的字节就是权威。

---

## 1. 术语

| 术语 | 说明 |
|---|---|
| `port` | 远端的一个串口（`ttyUSB0`、`uart1`） |
| `capture` | 一次「第一个 SUBSCRIBE → linger 结束」的字节流。`offset` 的作用域 |
| `offset` | capture 内 RX 字节位置，0 起，右开区间。**线上唯一的字节游标** |
| `seq` | **host 侧**日志条目号（RX 一行 / TX 一次写）。DATA 帧里的 seq 无效，填 0 |
| `tx_offset` | capture 内已写入 UART 的字节数 |
| `session` | 一个订阅者对某个 capture 的附着（`session_id`）。与 HELLO 的连接 id 不是同一个 |
| `writer` | 拥有 WRITE / SET_LINES / BREAK，以及订阅之后的 CONFIG 的 session |
| `linger` | 最后一个 session 离开后，capture_id 和未 ACK 发送缓存还保留的时间。默认 60s。与 `lease_ms` 无关 |
| `lease` | 单个 session 无 ACK/PING 的超时。到期只拆这个 session，不直接作废 capture |

---

## 2. 状态

```
Closed ──第一个 SUBSCRIBE──► Active(capture_id, offset=0)
Active ──更多 session attach─► Active（共享 capture，各自 cursor/window/ACK）
Active ──最后一个 session 离开► Linger（继续收 UART，保留未 ACK 缓存）
Linger ──linger_ms 到期──────► Closed（capture_id 作废）
Linger ──SUBSCRIBE(同一 id)──► Active（从远端仍持有的 offset resume）
端口错误 / 设备重启──────────► Closed（下次 SUBSCRIBE 新 capture_id）
```

- `CONFIG` 不创建 capture。
- 没有 `OPEN` 别名。创建 capture 的唯一操作是 `SUBSCRIBE`。
- linger 期间继续从 UART 读入发送缓存，这样短暂断线可以 resume。已经 ACK 的历史不要求还在。
- capture 关闭后，用旧 `capture_id` 订阅得到错误 `capture_expired`，不是 `mode:"gap"`。

---

## 3. 字节与日志

远端产出的是**字节流**。日志条目只在 host 生成。

- 新 capture 的 `offset` 从 0 开始。
- RX 行切分与 mining-serial 相同：host 以 `\n` 为界。`line` 可清洗；**raw/hex 是权威**。
- 不完整的行（块尾没有 `\n`）由 host 暂存，拼到下一块再切。远端不组行。
- `capture_id` 是设备内唯一的整数，必须落在 `[1, 2^53-1]`，否则 host 的 JS Number 对不齐。
- 时间：DATA 带 `ts_ms`（设备时钟，0 表示没有）。host 另记接收时间。

---

## 4. 帧

```
偏移  0  1  2    3     4      5     6
     +--+--+----+-----+------+-----+----------+
     | S| H|ver |type |flags | rsv | len u32  | payload
     +--+--+----+-----+------+-----+----------+
      0x53 0x48  0x01                         LE，10 字节头
```

- `len` 是 payload 字节数。整帧 ≤ `caps.max_frame`。
- **帧头 flags**：v1.0 必须为 0。压缩/加密不在本版。
- 坏 magic、坏版本、超长：回 `ERROR`，然后关闭连接。

| type | 名称 | payload |
|---|---|---|
| 0x01 | `HELLO` | JSON |
| 0x02 | `HELLO_ACK` | JSON |
| 0x03 | `CONTROL` | JSON，请求和应答都用它。没有单独的 SUBACK 类型 |
| 0x04 | `DATA` | 二进制，见 §4.2 |
| 0x05 | `ACK` | 二进制，见 §4.3 |
| 0x06 | `EVENT` | JSON |
| 0x07 | `ERROR` | JSON `{code, message}` |

控制面与数据面共用一条 TCP，按帧复用。

### 4.2 DATA payload（30 字节头 + raw）

```
 0  port_slot    u8
 1  capture_id   u64 LE
 9  seq          u32 LE     忽略，填 0。日志 seq 只由 host 分配
13  offset       u64 LE     本块 raw 的起始 RX 字节偏移
21  ts_ms        u64 LE
29  flags        u8
30  raw          bytes
```

payload flags（不是帧头 flags）：

| bit | 名 | 含义 |
|---|---|---|
| 0 | `GAP` | 此 offset 之前有缺口。raw 应为空。host 把自己的 newest 到该 offset 标成 gap |
| 1 | `TX` | 保留。v1.0 的 DATA 只承载 RX |
| 2 | `BATCH` | v1.0 的 DATA 必须置位。raw 是原始字节块，可含多行和半行。host 切行并分配 seq |

v1.0 只有这一种推送：DATA 必须带 `BATCH`。远端不组行、不分配 seq。host 按 `\n` 切，半行留下一块再拼。SUBACK 里的 `seq` 填 0，host 不把它当日志序号。

x86 hub 当前的「一帧一行」不符合本版，后续必须改成同样的块推送。没有第二种模式。

`GAP` 不与 `BATCH` 同时置位。`GAP.offset` 必须 ≥ 该 session 已发送的 offset；更小是协议错误。

### 4.3 ACK payload（21 字节）

```
 0  port_slot    u8
 1  capture_id   u64 LE
 9  ack_offset   u64 LE    已收入 host 缓存的 RX 字节位置（右开）
17  ack_seq      u32 LE    填 0xFFFFFFFF。确认的是字节 offset，不是行号
```

- 累计确认。host 每 `ack_interval_bytes`（默认 32 KiB）或 200ms 发一次，取先到者。
- `ack_offset` 及之前的字节，远端**可以立即释放**。
- ACK 也是流控：`sent - acked <= window_bytes` 时才继续向该 session 推。
- ACK 不是「必须保留历史」的信号。

---

## 5. 控制操作

通用应答：

```json
{ "id": 1, "ok": true,  "result": { } }
{ "id": 1, "ok": false, "error": { "code": "…", "message": "…" } }
```

`id` 原样回显。未知 `op` → `unknown_op`。未 HELLO 就发 CONTROL → `unauthorized` 并关闭。

### 5.1 HELLO / HELLO_ACK

```json
HELLO { "proto": "v1", "token": "…", "client_id": "mcp-A" }

HELLO_ACK { "ok": true, "result": {
  "proto": "v1",
  "fw_version": "1.0.0",
  "board": "esp32s3",
  "boot_id": "b7c1",
  "session_id": "连接 id，不是订阅 session",
  "ports": [{ "id": "uart1", "kind": "uart", "path": null }],
  "caps": { "push": true, "mux": true }
}}
```

- `proto` 不是 `"v1"` → `proto_mismatch` 并关闭。
- token 不符 → `unauthorized` 并关闭。未配置 token 则跳过鉴权。
- host 要求 `result.proto == "v1"` 且 `result.caps.push == true`，否则拒绝。
- `ports` 在 `result` 顶层，不在 `caps` 里面。
- 这里的 `session_id` 是这条 TCP 连接的 id。订阅 session 在 SUBSCRIBE 应答里另给。

### 5.2 CONFIG

```json
{ "id": 1, "op": "config", "port": "uart1",
  "baud_rate": 115200, "data_bits": 8, "stop_bits": 1,
  "parity": "none", "flow_control": "none" }
→ { "id": 1, "ok": true, "result": { "port": "uart1", "applied": { } } }
```

- 不创建 capture。订阅前允许，此时还没有 writer。
- 已有该端口的 session 时，只有 writer 可以改。非 writer → `not_controller`。
- 应答 `port` 必须是请求的端口 id。

### 5.3 SUBSCRIBE

```json
{ "id": 2, "op": "subscribe", "port": "uart1",
  "from": { "capture_id": 123, "offset": 4096, "seq": 0 },
  "mode": "replay+live",
  "window_bytes": 65536,
  "ack_interval_bytes": 32768,
  "lease_ms": 30000,
  "claim_writer": false }

→ { "id": 2, "ok": true, "result": {
  "session_id": "s-9",
  "port_slot": 0,
  "capture_id": 123,
  "mode": "resume",
  "writer": true,
  "start": { "seq": 0, "offset": 4096 },
  "oldest": { "seq": 0, "offset": 0 },
  "newest": { "seq": 0, "offset": 4096 },
  "window_bytes": 65536,
  "linger_ms": 60000
}}
```

host 依赖这些字段：`session_id`、`port_slot`、`capture_id`、`mode`、`writer`、`window_bytes`、`start.offset`、`start.seq`。

规则：

| 条件 | 结果 |
|---|---|
| 该端口没有活着的 capture，且没有 `from` | 新建。`mode:"new"`，`start.offset=0` |
| 已有 capture，没有 `from` | **附着，不新建**。从 `newest` 接实时。`mode:"resume"` |
| `from.capture_id` 就是当前 capture，且 `offset >= oldest` | `mode:"resume"`，从该 offset 推 |
| `from.capture_id` 匹配，但 `offset < oldest` | `mode:"gap"`，`start` 改成 `oldest`。host 接受缺口（更早的字节应已在 host） |
| `from.capture_id` 不存在或已过期 | **错误** `capture_expired`。不是 `mode:"gap"`。host 去掉 `from` 再订一次 |
| `mode:"live"` | 不回放，从 `newest` 起 |

- 第一个 session 是 writer。其余只读，除非 `claim_writer:true`。
- 抢权成功后，旧 writer 收到 EVENT `writer_revoked`。
- `window_bytes` 钳制到 `caps.window.max_bytes`，且不小于 4096。
- `port_slot` 在这条连接内稳定。之后的 DATA/ACK 都用这个槽，不用端口名。

### 5.4 PAUSE / RESUME

```json
{ "id": 3, "op": "pause",  "port": "uart1", "session_id": "s-9" }
{ "id": 4, "op": "resume", "port": "uart1", "session_id": "s-9" }
```

- writer 的 PAUSE 停止读 UART（真背压）。恢复时若中间有字节没进缓存，先发 GAP。
- 非 writer 的 PAUSE 只停自己的投递，不影响 capture 继续收。
- PAUSE 超过 `lease_ms` 视为租约失败，释放该 session；若它是 writer，writer 空出。

### 5.5 UNSUBSCRIBE

移除该 session。最后一个离开后 capture 进入 linger，**继续收 UART 进发送缓存**。已 ACK 的字节仍可释放。

关闭 TCP 等价于该连接上全部 unsubscribe，再断开。不必先发 unsubscribe。

### 5.6 WRITE / SET_LINES / BREAK

仅 writer。非 writer → `not_controller`。

```json
{ "id": 5, "op": "write", "port": "uart1", "session_id": "s-9",
  "data_b64": "QVRJKzENCg==", "op_id": "w-1" }
→ { "id": 5, "ok": true, "result": {
  "bytes_written": 6, "tx_offset": 0, "tx_log_seq": 1, "deduped": false } }
```

- `op_id` 可选。命中去重时 `deduped:true`，其余字段是第一次的结果。
- TX 不走 DATA。host 用这条应答自己记一条 TX 日志。
- `set_lines` 的 `dtr`/`rts` 省略表示不动。未接线 → `unsupported`。
- `break` 的 `duration_ms` 缺省 300。

### 5.7 HISTORY_*（可选，ESP32 不做）

`history_info` / `history_query` / `history_export`。

- `caps.capture.history` 为 `"none"` 时，这三个 op 必须回 `unsupported`。
- ESP32 必须声明 `"none"`。它不是存储端。
- x86 可以声明 `"ring"` 并实现 `history_query`，仅作 host 缓存缺口时的补充。缺了也不影响主路径。
- host 默认只用自己的缓存。不要把远端历史当权威。

### 5.8 PING

```json
{ "id": 90, "op": "ping", "t_ms": 1760000000123 }
→ { "id": 90, "ok": true, "result": { "t_ms": 1760000000123, "device_tick_ms": 123 } }
```

host 在 `lease_ms/3` 没有数据面流量时发 PING。设备超过 `lease_ms` 没有 ACK 也没有 PING，结束该 session，并发 EVENT `lease_expired`。capture 是否进入 linger 看是不是最后一个 session。

---

## 6. 发送缓存与流控

远端缓存 = 尚未被该端口所有仍需要这些字节的 session ACK 的 RX 字节，外加实现自己留的一小段 replay tail（可以是 0）。

介质自由：RAM 优先；RAM 满了可以溢到 SD 或 Flash。溢出仍是**原始字节**，不做行索引，不做 v0 那种 raw+index 日志段。ACK 之后对应区间必须可删，包括 SD/Flash 上的。

| 事件 | 行为 |
|---|---|
| 第一个 SUBSCRIBE | 创建 capture，offset=0，开始读 UART |
| 所有仍需要这段字节的 session 都已 ACK 到 X，或已被 GAP 跳过 | 可以删除 `offset < X` 的缓存。单个 session 的 ACK 不能删掉别的 session 还没确认的字节 |
| 缓存超过 `caps.capture.max_bytes` | 丢最旧的未确认字节，`oldest` 前移，相关 session 先收 GAP |
| 慢 session 的 cursor < oldest | 恢复投递前发 GAP。不阻塞别的 session，也不停 UART（除非 writer PAUSE） |
| 最后一个 session 离开 | linger。继续收 UART。到期释放 capture_id 和缓存 |
| 设备重启 | capture 作废 |

`max_bytes` 是**发送缓存上限**，不是日志保留量。x86 可以设得很大（它兼做实验性 history）；ESP32 应设成 RAM 热窗口能 cover 的量，溢出才碰 SD/Flash。

窗口按 session 计。超窗停止向该 session 推，UART 读取是否暂停只由 writer PAUSE 决定。多个 session 时，缓存至少要留到最慢的未确认 offset；慢到掉出 `max_bytes` 就对它发 GAP，不为它无限涨缓存。

---

## 7. 多 session

- 一个 capture 可被多个 session 附着。cursor、window、ACK 各自独立。
- 单 writer。首个附着者是 writer。`claim_writer` 可抢。writer 离开后，下一个附着者可以再当 writer（或显式 claim）。
- 配额、权限、审计、租约续期不在 v1.0。

---

## 8. host 工具面（向 mining-serial 靠拢）

agent 不看到帧，也不区分本地串口和远端。工具语义与 mining-serial 相同：

| 工具 | 语义 |
|---|---|
| `open` | 建会话。远端即 HELLO + CONFIG + SUBSCRIBE。`protocol:"v1"` |
| `read` | 读 host 缓存里尚未被这次 read 消费的字节。cat 语义 |
| `write` | 只发。非 writer 失败 `not_controller` |
| `transact` | 先记下 host 的 `rxCursor` 当 barrier，再 write，再 read。写之前的字节不算回包。barrier 在 host，不依赖远端历史 |
| `receive` | 观察窗口，直到 match / 静默 / 预算 |
| `dump_to_file` | 把已在 host 的字节流落盘 |
| `set_dtr_rts` / `send_break` | writer 控制线 |
| `log_query` / `log_stats` | 只查 host 日志。host 切行后才能查到 |

断线重连：`SUBSCRIBE { from: { capture_id, offset: last_acked } }`。

- `resume`：远端缓存还盖得住，接着推。
- `gap`：远端已经丢掉这段。host 保留自己已有的，从 `start.offset` 继续。
- `capture_expired`：去掉 `from`，新 capture。host 旧缓存仍在，只是接不上同一条 offset 空间。

没有第二种数据面。不带 BATCH 的数据帧 host 直接丢弃。

---

## 9. caps

`HELLO_ACK.result.caps`：

```json
{
  "push": true,
  "mux": true,
  "batch": true,
  "max_frame": 8192,
  "window": { "default_bytes": 65536, "max_bytes": 131072, "ack_interval_bytes": 32768 },
  "capture": { "linger_ms": 60000, "max_bytes": 65536, "history": "none" },
  "can_config": true,
  "can_set_lines": true,
  "can_break": true,
  "lease_ms": 30000,
  "events": true
}
```

- `batch` 必须为 true。v1.0 没有非 BATCH 的数据面。
- `history`：`"none"` | `"ring"` | `"segmented"`。ESP32 固定 `"none"`。
- `ports` 不在 caps 内。

---

## 10. 错误码

| code | 含义 | host |
|---|---|---|
| `bad_frame` | 帧头或长度非法 | 关闭并重连 |
| `bad_request` | JSON/字段非法 | 不重试这一条 |
| `unauthorized` | token 错或未 HELLO | 关闭 |
| `proto_mismatch` | 不是 v1 | 关闭，不要降到 v0 再猜 |
| `port_not_found` | 端口 id 不存在 | 不重试 |
| `capture_expired` | capture_id 已死 | 去掉 `from` 重新 SUBSCRIBE |
| `not_controller` | 非 writer | 可 `claim_writer` 后再试 |
| `unsupported` | 能力没有（HISTORY_*、未接线的控制线） | 不要当存储失败 |
| `unknown_op` | op 不认识 | 不重试 |
| `lease_expired` | 会话租约到 | 重新 SUBSCRIBE，capture 可能还在 |
| `busy` | 暂时不能再加 session | 稍后重试 |

`writer_revoked` 是 EVENT，不是错误码。`gap` 是 DATA flags，不是错误码。

---

## 11. 传输

- v1.0 只有 TCP。内核保证可靠有序。ACK 不做重传，只做流控和释放缓存。
- 明文 + token。不可信网络走 VPN/SSH。TLS、KCP 不在 v1.0。
- 心跳见 §5.8。

---

## 12. 不做的事

- 不保留 NDJSON / READ 拉取 / 远端日志权威。
- 新固件和 hub 都不实现旧链路。

---

## 13. 默认参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `linger_ms` | 60000 | capture_id 与未 ACK 缓存的保留。不是日志保留 |
| `max_bytes` | 由 caps 声明 | 发送缓存上限。ESP32 建议 64 KiB 量级；x86 可更大 |
| `window_bytes` | 64 KiB（设备可声明更大） | 每 session 未确认上限 |
| `ack_interval_bytes` | 32 KiB | |
| `ack_interval_ms` | 200 | |
| `lease_ms` | 30000 | 与 linger 独立 |
| `max_frame` | 由 caps 声明 | ESP32 建议 8 KiB。x86 可以到 256 KiB |

---

## 14. 一致性清单

新实现至少要满足：

1. 帧头 10 字节；DATA 头 30 字节；ACK 21 字节。没有第二个 `capture_id`。
2. HELLO 失败关闭。成功的 HELLO_ACK 含 `proto:"v1"`、`caps.push:true`、顶层 `ports`。
3. `capture_id` 在 `[1, 2^53-1]`。
4. CONFIG 不创建 capture；订阅前的 CONFIG 成功。
5. 已有 capture 时，不带 `from` 的 SUBSCRIBE 是附着，不是再开一个。
6. 过期 `capture_id` 回 `capture_expired`，不是 `mode:"gap"`。
7. DATA 必须带 BATCH。帧内 seq 被 host 忽略；host 按 `\n` 切行。半行跨帧拼接。
8. ACK 之后远端可以删缓存。未 ACK 的字节要么还在，要么已经发过 GAP。
9. ESP32：`history:"none"`，HISTORY_* 回 `unsupported`。x86 与 ESP32 都只发 BATCH。
10. 非 writer 的 WRITE/SET_LINES/BREAK 回 `not_controller`。
11. `transact` 的 barrier 用 host 收到 write 之前的 offset，不向远端要历史。

---

## 15. 明确不做（v1.0）

- 常驻记录（没人订阅也无限记）。
- 跨重启的 capture。
- 远端行索引、远端日志权威、v0 式 SD segment。
- 压缩、TLS、KCP、事件订阅流。
- 全局 seq、多 epoch。
- 固件侧兼容 v0。

v1.1 候选：配额/权限、lease 续期、TLS、KCP、端口热插拔事件。批量推送已经在 v1.0，不再算 v1.1。

---

## 16. 实现差距（非规范）

以 2026-11-13 代码为准。下面落后于本文，改代码时按 §14 收口。

已对齐：

- 帧头、DATA 30 字节头、ACK 21 字节（`src/remote/v1_codec.js`）。
- x86 Node hub 只发 BATCH，ACK 后释放发送缓存，溢出先 GAP。
- host 拒收不带 BATCH 的数据帧。`read/write/transact/receive/log_query` 走本地缓存。
- ESP32 固件 TCP 会话是 BATCH 发送缓存，`history:"none"`。

尚未对齐：

- ESP32 双路高速断线与 `config` 超时。RAM 满后溢到 SD/Flash 仍只做发送缓存。
