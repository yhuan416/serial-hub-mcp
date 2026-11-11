# serial-hub-mcp 串口 Hub 架构

> 状态：设计已定；host 侧 `tcp` 远端链路与假桥已实现，ESP32 桥固件待做。
> 配套契约见 [remote-link-protocol.md](./remote-link-protocol.md)（**v0 已定稿**）。

## 1. 目标

把 serial-hub-mcp 从「本机串口工具」升级为**一个 MCP hub**，同时对接：

- **本地串口**：`/dev/ttyUSB*`、`COM*`（现有能力，行为不变）。
- **远端串口**：ESP32-S3 无线串口桥（UART ↔ TCP/WS 隧道），可挂 SD 卡做**设备侧独立采集/落盘**。

设计约束：

1. 数据面**字节透明**：hub 不做 framing、不做内容判读，`read/transact/receive/dump_to_file` 语义不变。
2. 日志**以设备侧为权威**：远端连接的可回溯日志由设备采集并落盘，hub 只按需提取。
3. 数据流为 **host 按需 pull**，设备**不主动推**。
4. 本地/远端在**工具契约层对齐**：agent 不感知连接是本地还是远端。

## 2. 分层

```
┌──────────────────────────────────────────────────────┐
│ MCP 控制面（JSON-RPC / stdio，可选 Streamable HTTP） │  工具 schema + {ok,response}
├──────────────────────────────────────────────────────┤
│ tool handlers（conn / log / profile）                 │  按 connection_id 串行
├──────────────────────────────────────────────────────┤
│ Connection（游标 / 等待器 / 窗口 / 落盘）             │  ★ 与链路无关，不改
├──────────────────────────────────────────────────────┤
│ Link 抽象（ByteLink / port 鸭子类型）                 │
│   ├─ serial : SerialPort（本机）                      │
│   └─ remote : ESP32 桥（TCP/WS，pull RPC）            │
├──────────────────────────────────────────────────────┤
│ LogRouter（按 connection_id 路由日志后端）            │
│   ├─ 本地连接 → LogStore（现有 JSONL 分片）           │
│   └─ 远端连接 → RemoteLogStore（设备权威，RPC 代理）  │
└──────────────────────────────────────────────────────┘
```

关键点：`Connection` 只依赖 port 的鸭子类型（`on('data'|'error'|'close')`、
`open/close/write/drain/flush/set`、`path`），不依赖 `SerialPort` 本身。
测试已用 `fakePort()` 验证这一点，远端链路只需实现同一组成员。

## 3. Connection 的数据面语义（远端必须等价复刻）

| 操作 | 语义 | 关键不变量 |
|---|---|---|
| `read` | 从消费游标 `handled` 起 cat | 只前进不回头 |
| `transact` | 写后只关心「写之后到达」的字节 | **写前快照** `base` |
| `receive` | 窗口：`match > max_bytes > idle > budget` | 期间非匹配字节也如实带回 |
| `dump_to_file` | 实时边收边写 host 文件 | 大流量不经 MCP 搬运 |
| RX 缓冲 | 分段缓冲 + 绝对偏移；超 cap 丢最旧 | `rx_dropped` 计数可见 |

远端等价性靠 **设备侧字节偏移屏障**实现，而不是「长度快照/时间」：

- RX 字节流按**绝对偏移 `offset`** 记账（环形缓冲也按绝对偏移）。
- `WRITE`/`TRANSACT` 返回 `barrier_offset`（设备受理写时刻的 RX 偏移）。
- host 只消费 `offset > barrier_offset` 的字节 → 与本地 `base = _length` 精确等价。

> 注意区分：`offset` 是**字节**游标（用于 `READ`/屏障），`log_seq` 是**日志条目**序号
> （用于 `LOG_QUERY`）。两者不可混用，详见链路契约。

## 4. 数据流：pull-only + 两条独立通道

```
            ┌──────────────► SD：raw bytes + line index   （始终在采，离线可用、权威）
UART RX ────┤
            └──────────────► RAM live ring（小，供 READ 拉取；可丢最旧）

UART TX ◄──── WRITE / TRANSACT（host 发起），镜像进 SD 日志（dir=tx）
```

- **SD 通道与 hub 是否在线无关**，满足「hub 不提取时设备也能独立采集落盘」。
- **RAM ring 只桥接两次 pull 的间隔**，容量小、可丢；丢的是 live 视图，不是数据。
- host 追丢时 `READ` 必须能报 `gap=true` + `ring_oldest_seq`，提示改用 `LOG_EXPORT` 从 SD 补。

「按需 pull」的落地形态是 **带等待的 READ（long-poll）**，不是轮询：

- host 发起 `READ { from_seq, match, min_bytes, max_wait_ms, idle_timeout_ms, budget_ms }`；
- 设备内部等数据、扫 match、判 idle/budget，再一次性返回；
- 对应现有 `collect` / `_collectWindow` 的行为，避免轮询风暴。

## 5. 日志契约

### 5.1 条目 schema（本地/远端统一）

```json
{
  "seq": 12345,
  "ts": 1760000000000,
  "conn": "<hub connection_id>",
  "dir": "rx",
  "offset": 1000,
  "line": "hello 的 utf8 视图",
  "hex": "68656c6c6f",
  "bytes": 5
}
```

- `line` 按 `\n` 切行、剥结尾 `\r`；非 UTF-8 仍是 raw hex 事实源。
- TX 一次 write 记一条（不切行）。
- `offset` 是该条目在对应方向字节流中的绝对偏移（远端导出时用于回定位）。
- 残行单独暴露（`current_partial`），不占 `seq`。

### 5.2 seq 归属：per-source，hub 不改号

- 本地连接：host `LogStore` 生成全局单调 `seq`（现状）。
- 远端连接：**设备生成** per-source 单调 `log_seq`，hub 原样透出。
- 查询游标用 **`(connection_id, seq)` 复合键**；跨源查询**不按 seq 归并**，按连接分块。
- `earliest_seq` / `retention` 必须来自对应 source。
- 字节级游标（`READ`/`transact` 屏障）用 `offset`，与 `log_seq` 是两个独立空间。

### 5.3 时间

- 条目 `ts` 由**产生方**给出（本地=host，远端=设备）。
- 远端设备需 NTP（在线）或 tick + host 锚点（离线），契约里标明 `time_synced` 与精度。
- `time_from/time_to` 过滤基于该 `ts`，不做二次校正。

### 5.4 权威与镜像

| 连接 | 权威日志 | host 侧 |
|---|---|---|
| 本地 | host `LogStore` | 即权威 |
| 远端 | 设备 SD | `mirror`（live 镜像，可缺、非权威） |

返回中带 `source:"device"|"mirror"`、`authoritative:boolean`；`total/evicted` 等只用权威值。

### 5.5 设备侧存储格式

**存原始字节 + 轻量索引，条目在 host 侧还原**（不在固件里重写切行逻辑，避免漂移）：

```
raw-NNNNNN.bin   # 原样字节流
idx-NNNNNN.bin   # {byte_offset, dev_seq, dev_tick, dir} 的定长/变长记录
```

host 提取时复用与本地相同的切行器，生成 5.1 的条目 → **契约天然对齐**。
代价：`contains/regex` 无法下推到设备（需解析），设备只按 `seq/time/dir` 圈范围。

## 6. 工具面

**不新增工具名**（阶段一），只在现有工具上加链路参数：

- `open` 增加 `transport: "serial" | "remote"`、`endpoint`（`transport=remote` 时必填）。
- `get_status` 的 `config`/顶层带 `transport`、`endpoint`。

后续阶段（待远端链路落地）：

| 工具 | 语义 | 现状 |
|---|---|---|
| `list_endpoints` | 发现/列出远端桥 | 未实现 |
| `log_export` | 从设备权威日志按 `seq/时间` 段导出到 host 文件 | 未实现（不要复用 `dump_to_file`） |
| `log_query` 扩展 | 增加 `cursor/next_seq` 分页 | 未实现 |

`dump_to_file` 保持「**实时**捕获写 host 盘」，与历史导出语义分开。

## 7. 并发模型

- 同一 `connection_id` 的工具调用**严格串行**（游标/等待器非并发安全）。
- **不同 `connection_id` 之间放行**（hub 必须如此，否则一台设备的 `receive` 会堵死其它设备）。
- 无 `connection_id` 的工具（`list_ports/open/profile_*/log_* 全查/service_info`）走全局串行。

实现：`src/keyed_queue.js`，key = `args.connection_id ?? "__global__"`；`buildServer({ queue })`。

## 8. 能力协商（远端）

`open` 成功后 `get_status` / `INFO` 应暴露：

```
fw_version, transport, endpoint,
has_sd, sd_free_bytes, log_capacity_bytes,
ring_bytes, max_hold_ms, max_frame,
can_set_lines, can_break, can_config
```

ESP32-S3 原生 USB-JTAG 不支持 DTR/RTS，必须由 `can_set_lines` 表达，避免 agent 误用。

## 9. 端点模板注册（后续优化）

目标：让 `endpoint` 可插拔，而不是把 `tcp/udp/kcp/mqtt` 写死在 `open` 里。

### 9.1 端点串

`<scheme>://<authority>[/path][?k=v]`：

```
tcp://esp32s3-01:7000
udp://192.168.1.50:7000
kcp://192.168.1.50:7000
mqtt://broker:1883/topic/esp32s3-01?qos=1
ws://host:8080/mcp
```

### 9.2 注册表

```js
registerRemoteScheme("tcp", async (cfg) => {
  // 建链 + HELLO，返回 { rpc, info }；字节面语义由 RemoteConnection 统一实现
  return { rpc, info };
});
```

- `createRemoteLink(cfg)` 按 `endpoint` 的 scheme 查表；未注册时明确报错并列出可用 scheme。
- 每个 connector 声明/返回 transport profile（`info.caps`）：`max_frame`、`max_hold_ms`、
  `can_set_lines`、`can_break` 等；是否可靠/有序由 scheme 语义决定。
- 上层 NDJSON RPC 帧与传输无关；适配层负责分帧、重连、幂等重试与背压。

### 9.3 非请求/响应传输的适配

- UDP/KCP/MQTT(QoS0) **不保证顺序与不丢**：`READ` 的 `from_offset` 幂等与 `gap` 检测是硬要求，
  `transact` 的 `barrier_offset` 语义在各传输上必须保持一致。
- MQTT：request/response 两个 topic（用 `id` 关联）或 `reply-to`；QoS 决定 `reliable` 能力位。
- 设备 ring 满时通过 `FLOW`/拒绝表达背压，不能静默丢到无法区分「没数据」和「丢了」。

### 9.4 命名端点模板

- 常用 `endpoint` + 参数可直接复用现有 `profile_save`（已支持 `endpoint`），
  `open({profile:"esp32-lab"})` 一条接入。
- 后续可加 `endpoint_list` / `endpoint_probe`：发现（mDNS/UDP 广播）与连通性/能力探测。

### 9.5 落地顺序建议

v0 帧格式已定稿为 **NDJSON + base64**（见链路契约），落地顺序：

1. `serial`（已有）
2. `tcp`（**host 侧已实现**，NDJSON + 假桥端到端测试）
3. `ws`
4. `udp` / `kcp`（补齐可靠性/顺序说明；KCP 仍需上层 ack）
5. `mqtt`（request/response 适配 + QoS 语义）

## 10. 非目标 / 未决

- 不做设备主动推流（除非将来需要持续高速实时镜像）。
- 不做跨源全局 seq 归并。
- 明文链路下的鉴权/TLS 方案待定（至少 token + 局域网白名单）。
- 断线重连状态机（`reconnecting`）待远端链路阶段实现。