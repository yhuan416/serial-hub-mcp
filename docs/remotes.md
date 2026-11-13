# 配置远端（remotes）与端口汇总

MCP 侧支持预配置多个远端服务；`list_ports` 会**自动汇总本机 + 所有已配置远端**的端口，
不需要每次传 endpoint/token。`open` 也可以用名字引用远端。

## 1. 配置文件

默认路径（按优先级）：

1. 环境变量 `SERIAL_HUB_MCP_REMOTES`：直接给 JSON 字符串（容器/临时场景）
2. 环境变量 `SERIAL_HUB_MCP_REMOTES_FILE`：指定文件路径
3. `$XDG_CONFIG_HOME/serial-hub-mcp/remotes.json`（默认 `~/.config/serial-hub-mcp/remotes.json`）

格式：

```json
{
  "remotes": [
    {
      "name": "lab-x86",
      "endpoint": "tcp://192.168.1.50:7000",
      "token": "0123456789abcdef0123456789abcdef",
      "timeout_ms": 15000
    },
    {
      "name": "esp32-s3",
      "endpoint": "tcp://192.168.4.67:7000",
      "token_env": "ESP32_SHUB_TOKEN"
    }
  ]
}
```

也接受顶层数组：`[{ ... }, { ... }]`。

字段：

| 字段 | 必需 | 说明 |
|---|---|---|
| `name` | ✅ | 唯一名字；`open({remote:"..."})` 用它 |
| `endpoint` | ✅ | `tcp://host:port` |
| `token` | ⬜ | HELLO token；与 `token_env` 二选一 |
| `token_env` | ⬜ | 从环境变量读 token（推荐，避免明文落盘） |
| `timeout_ms` | ⬜ | 连接/HELLO/LIST_PORTS 超时，默认 15000 |
| `enabled` | ⬜ | `false` 则忽略该条 |
| `note` | ⬜ | 备注（仅展示） |

- 文件每次调用都会重新读取，改完立即生效。
- 建议文件权限 `0600`；token 优先用 `token_env`。
- 非法条目/重复名字会被跳过，并在 `list_ports.warnings` 里提示。

## 2. `list_ports` 汇总行为

```text
list_ports()
```

返回：

```json
{
  "ports": [
    { "path": "/dev/ttyUSB0", "source": "local" },
    { "id": "ttyACM0", "path": "/dev/ttyACM0", "source": "remote",
      "remote": "lab-x86", "endpoint": "tcp://192.168.1.50:7000", ... }
  ],
  "sources": [
    { "source": "local", "ok": true, "count": 1 },
    { "source": "remote", "name": "lab-x86", "endpoint": "tcp://192.168.1.50:7000",
      "ok": true, "count": 2, "ports_generation": 3,
      "caps": { "push": true, "batch": true }, "time": { ... } },
    { "source": "remote", "name": "esp32-s3", "endpoint": "tcp://192.168.4.67:7000",
      "ok": false, "error": "connect ECONNREFUSED ..." }
  ],
  "remotes_file": "/home/me/.config/serial-hub-mcp/remotes.json",
  "warnings": ["remote \"esp32-s3\": connect ECONNREFUSED ..."]
}
```

- 各远端**并行**查询；单个失败只体现在对应 `sources[i]`，不影响其它来源。
- `ports[]` 每条带 `source`（`local`/`remote`）与 `remote`（远端名字）。
- 远端条目包含 v0.1 的端口字段：`id/path/kind/manufacturer/serial_number/vendor_id/product_id/open/baud_rate/last_error/caps`。

可选参数：

| 参数 | 说明 |
|---|---|
| `include_local` | 是否包含本机端口，默认 true |
| `include_remote` | 是否包含已配置 remote，默认 true |
| `remote` | 只查某个已配置 remote（名字） |
| `endpoint` + `token` | 只查临时指定的远端（不读注册表） |
| `timeout_ms` | 单次远端查询超时 |

> 没有配置任何 remote 且不传 endpoint 时，`list_ports` 保持旧行为（只列本机）。

## 3. 用名字打开远端

```text
open({ remote: "lab-x86", port_id: "ttyACM0", baud_rate: 921600 })
```

- `remote` 自动填充 `endpoint/token`；显式传的 `endpoint/token` 优先。
- 等价于：
  `open({ transport:"remote", endpoint:"tcp://192.168.1.50:7000", token:"...", port_id:"ttyACM0" })`

## 4. 容器/临时场景

```bash
export SERIAL_HUB_MCP_REMOTES='[
  {"name":"lab","endpoint":"tcp://192.168.1.50:7000","token":"..."}
]'
```

或挂载配置文件：

```bash
export SERIAL_HUB_MCP_REMOTES_FILE=/etc/serial-hub-mcp/remotes.json
```

## 5. 排障

| 现象 | 排查 |
|---|---|
| `sources` 里某 remote `ok:false` | 网络/端口不通、token 不对、服务没起 |
| `remote 不存在: xxx` | 检查 `remotes.json` 的 `name`，或 `list_ports` 返回值里的名字 |
| token 为空 | `token_env` 指向的环境变量未设置 |
| 列表里没有某个远端 | `enabled:false`、endpoint 非法、名字重复（看 `warnings`） |