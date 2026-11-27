# Tools

20 个 MCP 工具。所有工具返回统一结构：

```json
{ "ok": true, "response": {} }
```

业务失败返回 `{ "ok": false, "error": { "message": "..." } }`，MCP 层同时把 `isError` 置为
`true`，不会提升成 JSON-RPC 错误。成功结果里还带 `durationMs`。

## 总表

| 工具             | 只读 | 破坏性 | 作用                                      |
| ---------------- | ---- | ------ | ----------------------------------------- |
| `list_ports`     | ✅   |        | 本机端口 + 所有已配置远端                 |
| `open`           |      |        | 打开连接（本机 / 远端 / profile）         |
| `open_list`      | ✅   |        | 成功打开过的端口索引（历史，不含活动连接）|
| `list_connections` | ✅ |        | 当前活动连接、打开/最后收发/空闲时间      |
| `close`          |      |        | 关闭连接                                  |
| `get_status`     | ✅   |        | 单个连接状态、计数、控制线                |
| `read`           | ✅   |        | 从读游标读取字节                          |
| `write`          |      |        | 发送字节                                  |
| `transact`       |      |        | 写入后等待回包                            |
| `receive`        |      |        | 窗口式采集，直到 match/静默/预算/字节上限 |
| `dump_to_file`   |      |        | 按 seq/时间/offset 导出 host 缓存         |
| `set_dtr_rts`    |      |        | 设置/脉冲 DTR、RTS                        |
| `send_break`     |      |        | 发送 BREAK                                |
| `profile_list`   | ✅   |        | 列出连接 profile                          |
| `profile_save`   |      | ✅     | 保存/覆盖 profile                         |
| `profile_delete` |      | ✅     | 删除 profile                              |
| `log_query`      | ✅   |        | 检索 host 日志                            |
| `log_stats`      | ✅   |        | 日志存储统计                              |
| `log_clear`      |      | ✅     | 清空 host 日志                            |
| `service_info`   | ✅   |        | 服务名、版本、端点/存储/限额、changelog     |

`read` 会推进读游标，所以不是幂等的，但不修改外部环境；`dump_to_file` 会创建文件。
`profile_save` 会覆盖同名 profile，`log_clear` / `profile_delete` 会删数据。

## 连接生命周期

### `list_ports`

```text
list_ports()
list_ports({ include_remote: false })
list_ports({ remote: "lab-x86" })
list_ports({ endpoint: "tcp://192.168.1.50:7000", token: "..." })
```

返回扁平的 `ports[]`（每条带 `source` / `remote`）和按来源分组的 `sources[]`。单个远端失败
只体现在对应的 `sources[i]`，不影响其它来源。

### `open`

| 参数                                                  | 说明                                           |
| ----------------------------------------------------- | ---------------------------------------------- |
| `port`                                                | 本机路径，如 `/dev/ttyUSB0`                    |
| `profile`                                             | 已保存的 profile 名；显式参数优先              |
| `sn` / `vid` / `pid`                                  | 按设备标识自动找路径                           |
| `baud_rate`                                           | 默认 `115200`                                  |
| `data_bits` / `stop_bits` / `parity` / `flow_control` | 默认 `8/1/none/none`                           |
| `newline`                                             | `write/transact` 的默认换行：`none/cr/lf/crlf` |
| `rx_buffer_size`                                      | 内部 RX 缓冲上限，默认 4 MiB                   |
| `transport`                                           | `serial`（默认）或 `remote`                    |
| `endpoint`                                            | 远端地址，`tcp://host:7000`                    |
| `token`                                               | 远端 HELLO token                               |
| `remote`                                              | 已配置的 remote 名；自动填 endpoint/token      |
| `port_id`                                             | 远端端口 ID，如 `ttyACM0` / `uart1`            |
| `claim_writer`                                        | 远端已有 writer 时抢写权                       |
| `name`                                                | 这次打开的备注名，写入 `open_list`             |

示例：

```text
open({ port: "/dev/ttyUSB0", baud_rate: 115200 })
open({ profile: "quarkpi" })
open({ sn: "5909067506", baud_rate: 921600 })
open({ remote: "lab-x86", port_id: "ttyACM0", baud_rate: 921600 })
```

返回里的 `token` 是 `***`。成功后按 `endpoint + port_id + baud` 去重写入 `open_list`。

打开前建议先 `list_connections`。如果相同链路 + 帧格式的连接已经开着，返回里会多出
`duplicate_of`（已有连接的 id、打开时间、最后收发时间、收发字节），`hint` 会提示复用或先
`close`；本机串口重复打开失败时，错误信息里也会带上已有连接的 id。

### `list_connections` / `open_list` / `close` / `get_status`

```text
list_connections()                           // 全部活动连接，按空闲时间从长到短
list_connections({ transport: "remote" })
list_connections({ port: "ttyACM0" })        // 按端口/端点子串过滤
list_connections({ idle_minutes: 30 })       // 只看 30 分钟没读写的连接

open_list()                                  // 打开过的端口索引（历史）
open_list({ port: "ttyACM0", name: "main" })
get_status({ connection_id: "..." })
get_status()                 // 等价于列出全部连接状态
close({ connection_id: "..." })
```

`list_connections` 每条包含 `connection_id`、`transport`、`endpoint`、`port`、`config`、
`opened_at`、`last_rx_at`、`last_tx_at`、`idle_ms`、`bytes_in/out`、`rx_dropped`，
远端连接还有 `writer`。用它找出“开了但没人用”的连接后再 `close`。

## 收发

### `read`

```text
read({ connection_id: "..." })
read({ connection_id: "...", wait_ms: 1000, min_bytes: 16 })
read({ connection_id: "...", match: "OK", wait_ms: 3000 })
```

参数：`match`、`match_encoding`（`utf8/hex/base64`）、`min_bytes`、`wait_ms`、`include_hex`。
默认立即返回自读游标以来的全部字节（cat 语义）。`hex` 默认只在非文本数据时返回。

### `write`

```text
write({ connection_id: "...", data: "AT", newline: "crlf" })
write({ connection_id: "...", data: { hex: "AF 01 00" }, encoding: "hex" })
```

`data` 可以是字符串，也可以是 `{ text }` / `{ hex }` / `{ base64 }`。

### `transact`

```text
transact({
  connection_id: "...",
  data: "AT",
  newline: "crlf",
  match: "OK",
  timeout_ms: 5000
})
```

只关心写入之后到达的字节，写前缓冲里的噪声不算回包。返回 `matched` / `timed_out` /
`stopped_reason`。

### `receive`

```text
receive({ connection_id: "...", start: "flush", budget_ms: 5000 })
receive({ connection_id: "...", match: "login:", budget_ms: 15000 })
receive({ connection_id: "...", start: "flush", reset: "dtr", budget_ms: 15000 })
```

| 参数              | 说明                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| `start`           | `cursor`（默认，从读游标）或 `flush`（跳到当前最新字节，只收之后新到的） |
| `reset`           | `none` / `dtr` / `rts`；复位脉冲，默认 `none`                            |
| `reset_pulse_ms`  | 复位脉冲宽度，默认 100                                                   |
| `match`           | 出现即停的字节串                                                         |
| `idle_timeout_ms` | 静默即停，默认 300                                                       |
| `budget_ms`       | 总预算，默认 10000                                                       |
| `max_bytes`       | 返回字节上限                                                             |

结束原因看 `stopped_reason`：`match` / `idle` / `budget` / `max_bytes`。窗口内到达的所有字节
都会带回，不丢。

## 缓存与日志

### `dump_to_file`

```text
dump_to_file({ connection_id: "...", time_from: 1760000000000 })
dump_to_file({ connection_id: "...", seq_from: 120, seq_to: 180 })
dump_to_file({ connection_id: "...", offset_from: 0, offset_to: 4096 })
```

导出 host 已有缓存，立刻返回 `file_id` / `sha256` / `download_path`。不读新数据，不移动
read 游标。`GET /dumps/<file_id>` 用与 `/mcp` 相同的 Bearer token 下载。

### `log_query`

```text
log_query({ connection_id: "...", limit: 50, order: "desc" })
log_query({ contains: "error", time_from: 1760000000000 })
log_query({ regex: "wpa|dhcp", dir: "rx", limit: 200 })
```

支持 `dir`、`seq_from` / `seq_to`、`time_from` / `time_to`、`contains`、`regex`、`limit`、
`cursor`、`order`、`include_hex`。省略 `connection_id` 时聚合本地和所有远端 host 缓存。

### `log_stats` / `log_clear`

```text
log_stats()
log_stats({ connection_id: "..." })
log_clear({ connection_id: "..." })
log_clear({ confirm: true })     // 清空全部 host 日志
```

远端日志只清 host 缓存，不清设备。

## 控制线

```text
set_dtr_rts({ connection_id: "...", dtr: false, pulse_ms: 100 })
set_dtr_rts({ connection_id: "...", rts: true })
send_break({ connection_id: "...", duration_ms: 300 })
```

`pulse_ms` 会先设电平、保持该时长后反转，适合 Arduino 自动复位。ESP32 进下载模式需要多拍
时序时，分多次调用。

## Profile

```text
profile_list()
profile_save({
  name: "quarkpi",
  port: "/dev/ttyUSB0",
  baud_rate: 921600,
  newline: "crlf",
  note: "主控"
})
profile_delete({ name: "quarkpi" })
```

profile 存在 `$XDG_CONFIG_HOME/serial-hub-mcp/profiles.json`；容器里用
`SERIAL_HUB_MCP_PROFILES_DIR` 指到可写目录。返回里的 token 为 `***`，文件里是原值。

## 服务信息

```text
service_info()
```

返回服务名、版本、端点、部署（运行时/访问地址/启动时间）、存储（路径与体积/保留上限）、
限额（请求体/工具数/远端数）、接入片段，以及 `CHANGELOG.md` 的前 20 行。
排查“连的是哪个版本”先看它；HTTP 模式下与 `GET /info` 同一份数据
（加 `?format=html` 是可读页面）。
