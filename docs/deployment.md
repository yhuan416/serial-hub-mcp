# Deployment

三种常见形态：

1. **stdio**：MCP 客户端把 `serial-hub-mcp` 当子进程拉起。
2. **Streamable HTTP**：一个常驻进程，多个 agent 共用连接和日志。
3. **Docker / x86 hub**：MCP 中心 + 一台或多台 `serial-hub-server`。

## stdio

```bash
node src/server.js
# 或 npm link 后
serial-hub-mcp
```

客户端配置见 [getting-started.md](getting-started.md#4-接-mcp-客户端)。

stdio 模式没有 Web 页面，也没有 HTTP 端口，安全边界由客户端进程决定。

## Streamable HTTP

```bash
SERIAL_HUB_MCP_HTTP_TOKEN="$(openssl rand -hex 32)" \
  node src/server.js --http --host 0.0.0.0 --port 8787
```

端点：

| 路径               | 鉴权           | 用途                         |
| ------------------ | -------------- | ---------------------------- |
| `/mcp`             | Bearer         | MCP Streamable HTTP          |
| `/health`          | 免             | 健康检查                     |
| `/info`            | 免             | 服务信息、工具数、changelog  |
| `/dumps/<file_id>` | Bearer         | 下载 `dump_to_file` 产物     |
| `/`                | 免（页面本身） | Web UI；`/api/*` 仍需 Bearer |

- 每个请求创建独立的 MCP server，但共享同一个连接管理器、日志路由和队列，所以连接跨请求保留。
- 绑定非回环地址但没设 token 会拒绝启动；确需匿名访问加 `--allow-anonymous` 或
  `SERIAL_HUB_MCP_HTTP_ALLOW_ANONYMOUS=1`。
- 反向代理需要支持 SSE/流式响应，并把 `Authorization` 原样转发；不要把 `/mcp` 做成缓冲式代理。
- 绑定 loopback 时默认只接受本机 `Host` / `Origin`（防 DNS rebinding）。用主机名、反向代理或
  容器名访问时，设置 `SERIAL_HUB_MCP_HTTP_ALLOWED_HOSTS` / `_ORIGINS`，值要包含端口。
- 可以用 `SERIAL_HUB_MCP_HTTP_TOKEN_FILE` 挂载 token 文件，避免 token 出现在 `docker inspect`
  的环境变量里。
- 关闭网页界面：`SERIAL_HUB_MCP_HTTP_UI=0`。

## Docker：MCP 中心

镜像只做 MCP 中心，不挂串口；本机串口由旁边的 `serial-hub-server` 通过 TCP 暴露。

```bash
docker build -f docker/serial-hub-mcp.Dockerfile -t serial-hub-mcp:0.3.3 .

docker run -d --name serial-hub-mcp --restart unless-stopped \
  --add-host=host.docker.internal:host-gateway \
  -p 8788:8787 \
  -e SERIAL_HUB_MCP_HTTP_TOKEN="$(cat ~/.config/serial-hub-mcp/http.token)" \
  -v ~/.local/share/serial-hub-mcp:/data \
  -v ~/.config/serial-hub-mcp:/config:ro \
  serial-hub-mcp:0.3.3

# 更推荐：token 走文件，避免出现在 docker inspect 的环境变量里
docker run -d --name serial-hub-mcp --restart unless-stopped \
  --add-host=host.docker.internal:host-gateway \
  -p 8788:8787 \
  -e SERIAL_HUB_MCP_HTTP_TOKEN_FILE=/run/secrets/mcp_http_token \
  -v ~/.local/share/serial-hub-mcp:/data \
  -v ~/.config/serial-hub-mcp:/config:ro \
  -v ~/.config/serial-hub-mcp/http.token:/run/secrets/mcp_http_token:ro \
  serial-hub-mcp:0.3.3
```

镜像里已经设置：

- `SERIAL_HUB_MCP_HTTP=1`、`HTTP_HOST=0.0.0.0`、`HTTP_PORT=8787`
- `XDG_CONFIG_HOME=/config`、`XDG_CACHE_HOME=/data`
- `SERIAL_HUB_MCP_REMOTES_FILE=/config/remotes.json`
- v2 store、dumps、v1 缓存、profiles、opens 都在 `/data` 下
- 健康检查走 `bash /dev/tcp/127.0.0.1/8787`

数据目录建议：

| 宿主路径                        | 容器路径          | 内容                                |
| ------------------------------- | ----------------- | ----------------------------------- |
| `~/.config/serial-hub-mcp`      | `/config`（只读） | `remotes.json`、`http.token`        |
| `~/.local/share/serial-hub-mcp` | `/data`           | 日志、dump、store、v1 缓存、profile |

删除容器不会丢 `/data`；正在开着的串口会话会断，重开后从游标续上。

绑定宿主机目录时，确保容器内的 `node` 用户（uid 1000）可写，例如
`sudo chown -R 1000:1000 ~/.local/share/serial-hub-mcp`；否则用 Docker named volume。
容器以非 root 运行，宿主机 root 创建的目录默认不可写。

如果 MCP 容器要访问宿主机上的 hub，用
`--add-host=host.docker.internal:host-gateway`，`remotes.json` 里写
`tcp://host.docker.internal:7000`。跨机则写实际 IP。

## Docker：x86 serial-hub-server

```bash
cp docker/serial-hub-server.env.example docker/serial-hub-server.env
# 写入 SERIAL_HUB_SERVER_TOKEN
docker compose -f docker/docker-compose.hub.yml up -d --build
```

要点：

- 绑定宿主机 `/dev`，只读挂 `/run/udev`，`SerialPort.list()` 才能拿到厂商/序列号。
- 用设备号放行，不要逐个 `--device`：
  - `c 166:* rmw` → ttyACM
  - `c 188:* rmw` → ttyUSB
  - 不要放行 `c 4:*`（控制台和 ttyS）
- `group_add: ["20"]` 对应 Debian 系 `dialout`。
- 每 2 秒扫描端口；新节点会出现，节点消失后从列表去掉。扫描只加不减的旧行为已修正。
- `--ports` 只暴露真实在用的串口，避免把 `ttyS*` 全部暴露。
- hub token 可以用 `SERIAL_HUB_SERVER_TOKEN_FILE` 挂载文件，或直接放进 `<data-dir>/token`；
  后者是默认生成位置（0600）。

n100 之类的现成 compose 见 [docker/docker-compose.n100.yml](../docker/docker-compose.n100.yml)。
完整参数见 [x86-hub-server.md](x86-hub-server.md)。

## systemd

`docs/deploy/` 提供单元和 env 样例：

```bash
sudo cp docs/deploy/serial-hub-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now serial-hub-server
sudo cat /var/lib/serial-hub-server/token
```

运行用户加入 `dialout`，数据目录和 token 文件权限按现场收紧。

## Harbor / 私有镜像

镜像可以推到自建 Harbor：

```bash
docker build -f docker/serial-hub-mcp.Dockerfile \
  -t harbor.example.com/ipcs/serial-hub-mcp:0.3.3 .
docker push harbor.example.com/ipcs/serial-hub-mcp:0.3.3
```

Harbor 是私有的，没有公开 pulls badge；README 里不要放会 404 的 npm/Docker 动态徽章。
`latest` 是否维护由发布流程决定，部署时建议固定版本 tag。

## 升级与回滚

MCP 的连接、capture、读游标都在进程内存里，替换容器会让当前会话断开；日志和游标在 `/data`
里，重开后可以续上（capture 过期则新建）。

```bash
# 升级
docker rm -f serial-hub-mcp
docker run -d ... harbor.example.com/ipcs/serial-hub-mcp:0.3.3

# 回滚：把镜像 tag 换回 0.3.1
```

升级前建议：

1. `GET /health`、`GET /info` 记录当前版本。
2. 确认没有正在跑的长任务（`receive` / 长 `dump`）。
3. 保留上一版镜像 tag，必要时直接回滚。
4. 升级后跑一次 `service_info` 和 `list_ports` 冒烟。

## 网络与安全

- 远端链路和 HTTP 都是明文；跨公网请走 VPN 或 SSH 隧道。
- 不要把 7000（hub）和 8787（MCP）直接暴露到公网。
- hub 的 token 在 `<data-dir>/token`（0600）或 `SERIAL_HUB_SERVER_TOKEN_FILE`；MCP 的 token 在
  `mcp.env` / 容器环境 / `SERIAL_HUB_MCP_HTTP_TOKEN_FILE` 里。
- `remotes.json` 推荐 `token_env`，不要提交到 git。
- 用文件挂载 secret 时，文件权限至少 `0600`；缺失或为空时进程会拒绝启动。
