# serial-hub-mcp

串口 MCP，也是一个 hub：一个进程里可以同时握着本机 UART，以及远端串口。远端可以是 ESP32-S3 无线桥（[`serial-hub-bridge`](https://github.com/yhuan416/serial-hub-bridge)），也可以是跑在 Linux 上的 `serial-hub-server`。

字节面保持透明：进什么出什么，不组帧、不判读。日志在 host 上按行切开再检索。远端只保留还没被 ACK 的待发送字节。

English: [README.md](README.md)。

## 目录

```
src/server.js            MCP 入口（stdio / HTTP）
src/connection.js        连接管理。远端一律走二进制会话
src/tools/               MCP 工具：conn / log / profile
src/remote/              帧编解码与 host 侧客户端
src/hub-server/          x86 serial-hub-server
src/links/               本机串口
src/sdk/                 MCP HTTP / 工具注册
docker/                  hub 镜像与 compose
docs/                    协议、远端配置、部署
test/                    单测与 smoke
```

`package.json` 的 `bin`：`serial-hub-mcp` → `src/server.js`，`serial-hub-server` → `src/hub-server/index.js`。不要挪这两个入口。

## 安装

```bash
npm install -g serial-hub-mcp
```

需要 Node.js >= 18。Linux 上把用户加进 `dialout`，否则打不开 `/dev/ttyUSB*`、`/dev/ttyACM*`。

## 客户端

stdio：

```json
{
  "mcpServers": {
    "serial": { "command": "serial-hub-mcp" }
  }
}
```

HTTP：

```bash
serial-hub-mcp --http
SERIAL_HUB_MCP_HTTP_TOKEN=secret serial-hub-mcp --http --host 0.0.0.0 --port 8787
```

默认只听 `127.0.0.1:8787/mcp`。绑到非本机地址时如果不设 token，谁能连上谁就能操作串口。`GET /health` 和 `GET /info` 不鉴权，也不带密钥。

## 工具

| 工具 | 作用 |
|---|---|
| `list_ports` | 本机端口，并汇总 `remotes.json` 里每个远端 |
| `open` / `close` | 打开、关闭。远端用 `remote` 或 `endpoint`+`token` |
| `read` / `write` / `transact` | 读、写、写完等回包 |
| `receive` / `dump_to_file` | 观察一段时间，或直接落盘 |
| `set_dtr_rts` / `send_break` | 控制线与 BREAK |
| `get_status` | 连接状态、计数、是否在重连 |
| `log_query` / `log_stats` / `log_clear` | 查 host 上已经切开的日志 |
| `log_export` / `log_sync` | 把远端历史导到本机（旧 SD 日志路径；新链路以 host 缓存为准） |
| `cache_set` | 把远端 RAM 发送缓存大小写入设备 NVS |
| `profile_*` | 保存常用连接参数 |
| `service_info` | 版本与 changelog |

## 快速开始

远端名字写在 `~/.config/serial-hub-mcp/remotes.json`，见 [docs/remotes.md](docs/remotes.md)。

```text
list_ports()
open({ remote: "esp32-s3", port_id: "uart1", baud_rate: 1500000 })
open({ remote: "n100", port_id: "ttyACM0", baud_rate: 115200 })
receive({ connection_id: "...", budget_ms: 5000 })
cache_set({ connection_id: "...", cap_bytes: 524288 })
close({ connection_id: "..." })
```

不写名字也可以：

```text
open({
  transport: "remote",
  endpoint: "tcp://<bridge-ip>:7000",
  token: "<token>",
  port_id: "uart1",
  baud_rate: 1500000
})
```

链路是明文 TCP。只在局域网或 VPN 里用。

## 发送缓存

ESP32 的 RAM 发送缓存默认 256KiB，存在 NVS 命名空间 `shb` 的 `cap_bytes`。范围 32KiB–2MiB，4KiB 对齐。`cache_set` 写入后，已经在跑的 capture 保持旧大小，下次新建才换成新值。HELLO 的 `caps.capture.max_bytes` 是当前配置值。

RAM 满了会先把未 ACK 的字节溢到 SD（`/sdcard/shb-cache/`）。写失败才 GAP。x86 hub 的缓存大小用启动参数，不走这条 NVS。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/remote-link-protocol-v1.md](docs/remote-link-protocol-v1.md) | 现行链路契约 |
| [docs/remotes.md](docs/remotes.md) | `remotes.json` |
| [docs/x86-hub-server.md](docs/x86-hub-server.md) | x86 hub 部署 |
| [docs/deploy/](docs/deploy/) | systemd 单元与 env 样例 |
| [docs/hub-architecture.md](docs/hub-architecture.md) | 早期分层笔记，和现行契约不一致的地方以协议文档为准 |

## 开发

```bash
npm install
npm test
npm run lint
```

远端相关测试在进程里起一个 hub，不需要设备和网络。
