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
| `open` / `close` | 打开、关闭。远端用 `remote` 或 `endpoint`+`token`。第二路要写传 `claim_writer:true` |
| `read` / `write` / `transact` | 读、写、写完等回包 |
| `receive` | 观察一段时间 |
| `dump_to_file` | 按 seq、时间或 offset 导出已有缓存，不读新数据 |
| `set_dtr_rts` / `send_break` | 控制线与 BREAK |
| `get_status` | 连接状态、计数、是否在重连 |
| `open_list` | 查这个口开过什么波特率、叫什么名字 |
| `log_query` / `log_stats` / `log_clear` | 查 host 上已经切开的日志 |
| `profile_*` | 保存常用连接参数 |
| `service_info` | 版本与 changelog |

## 快速开始

远端名字写在 `~/.config/serial-hub-mcp/remotes.json`，见 [docs/remotes.md](docs/remotes.md)。

```text
list_ports()
open({ remote: "esp32-s3", port_id: "uart1", baud_rate: 1500000 })
open({ remote: "n100", port_id: "ttyACM0", baud_rate: 115200 })
receive({ connection_id: "...", budget_ms: 5000 })
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

`log_query` / `dump_to_file` 不传 `time_from` 会带回缓存里更早的数据。只要开始观察之后的，先取当前 epoch ms 再传 `time_from`。`receive` 默认从读游标接着收，可能含旧字节；`start=flush` 把游标跳到当前最新字节，只收之后新到的，不清缓存。

## 发送缓存

发送缓存和保留时间不进 MCP 工具列表。调试时用默认值即可。

要改的话：

- x86 hub：重启时设 `SERIAL_HUB_SERVER_CAPTURE_MAX_BYTES`、`SERIAL_HUB_SERVER_RETENTION_DAYS`、`SERIAL_HUB_SERVER_LEASE_MS`。参数表见 [docs/x86-hub-server.md](docs/x86-hub-server.md)。
- ESP32 桥：NVS 命名空间 `shb` 的 `cap_bytes`，默认 256KiB，范围 32KiB–2MiB，4KiB 对齐。也可对桥发 v1 控制帧 `{"op":"cache_set","cap_bytes":262144}`。`applied=next` 表示当前 capture 还用旧缓冲，最后一个会话离开并过 60 秒后新建才换。不是重启。
- MCP 自己的日志、dump、捕获缓存默认留 7 天。`SERIAL_HUB_MCP_CACHE_TTL_DAYS=0` 关闭。要长期保存请 `dump_to_file` 后下载到本机。
- `open` 不暴露窗口、租约、重连参数。已存 profile 里如果写过这些字段，打开时仍生效。返回和 `profile_list` 里的 token 是 `***`。

RAM 满了会先把未 ACK 的字节溢到 SD（`/sdcard/shb-cache/`）。写失败才 GAP。x86 hub 的缓存大小用启动参数，不走这条 NVS。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/remote-link-protocol-v1.md](docs/remote-link-protocol-v1.md) | 现行链路契约 |
| [docs/remotes.md](docs/remotes.md) | `remotes.json` |
| [docs/x86-hub-server.md](docs/x86-hub-server.md) | x86 hub 部署 |
| [docs/deploy/](docs/deploy/) | systemd 单元与 env 样例 |
| [docs/hub-architecture.md](docs/hub-architecture.md) | 早期分层笔记，和现行契约不一致的地方以协议文档为准 |

## Docker

MCP 容器不挂串口。本机端口另起一个 `serial-hub-server`，MCP 用 TCP 访问它，和访问 n100、ESP32 一样。

配置和缓存不进镜像，固定在宿主机：

| 路径 | 内容 |
|---|---|
| `/var/lib/serial-hub-mcp/config/mcp.env` | HTTP token、各 hub 的 token |
| `/var/lib/serial-hub-mcp/config/remotes.json` | 远端列表 |
| `/var/lib/serial-hub-mcp/data/` | 日志、抓取、游标、v1 缓存 |
| `/var/lib/serial-hub-server/server.env` | 本机 hub token |
| `/var/lib/serial-hub-server/data/` | 本机 hub 数据 |

```bash
sudo mkdir -p /var/lib/serial-hub-mcp/{config,data} /var/lib/serial-hub-server/data
sudo chown -R 1000:1000 /var/lib/serial-hub-mcp /var/lib/serial-hub-server
sudo cp docker/serial-hub-mcp.env.example /var/lib/serial-hub-mcp/config/mcp.env
sudo cp docker/serial-hub-server.env.example /var/lib/serial-hub-server/server.env
sudo cp docker/remotes.json.example /var/lib/serial-hub-mcp/config/remotes.json
docker compose -f docker/docker-compose.mcp.yml --profile local up -d
```

镜像名用 `serial-hub-mcp` 和 `serial-hub-server`，不写仓库地址。`LOCAL_HUB_TOKEN` 必须和本机 hub 的 `SERIAL_HUB_SERVER_TOKEN` 相同。agent 连 `http://<host>:8787/mcp`，带 `Authorization: Bearer <SERIAL_HUB_MCP_HTTP_TOKEN>`。多个 agent 共用这一份连接和日志。删容器不会丢 `/var/lib` 里的配置和缓存；正在开着的会话会断，重开后从游标续上。

本机 hub 不要在部署文件里写死 `/dev/ttyACM0` 这种节点。hub 每 2 秒扫一次端口，但容器看得见不等于打得开：

- 绑定宿主机 `/dev`，新节点才会出现在容器里。只读挂 `/run/udev`，`SerialPort.list()` 才能拿到串口信息。
- 用设备号放行，不要按路径枚举：`c 166:* rmw` 是 ttyACM，`c 188:* rmw` 是 ttyUSB。不要放行 `c 4:*`（控制台和 ttyS）。
- 进程要在 `dialout`（本机 gid 20）里。不要为了串口把容器设成 privileged。
- 扫描会加入新口。设备节点消失后从列表去掉，正在打开的口会被关掉。

本机 hub 按上面这套跑：绑定 `/dev`，放行 `c 166:*` 和 `c 188:*`，不再逐个 `--device`。没有 sudo 时，配置和数据可以放在 `~/.config/serial-hub-mcp` 与 `~/.local/share/serial-hub-server`，不必强行用 `/var/lib`。MCP 容器通过 Docker 网络访问 `tcp://serial-hub-server:7000`，不要写成容器里的 localhost。

## 开发

```bash
npm install
npm test
npm run lint
```

远端相关测试在进程里起一个 hub，不需要设备和网络。
