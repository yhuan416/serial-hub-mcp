# Getting started

本文从零跑通 `serial-hub-mcp`：安装、接客户端、打开一个串口。

## 1. 环境要求

- Node.js >= 18（CI 覆盖 18/20/22；Docker 镜像用 Node 22）。
- Linux 上把用户加入 `dialout`：

  ```bash
  sudo usermod -aG dialout "$USER"
  # 重新登录后生效
  ```

- 可选：Docker，用于跑 x86 `serial-hub-server`。

## 2. 安装

项目还没有发布到 npm，先从源码跑：

```bash
git clone https://github.com/yhuan416/serial-hub-mcp.git
cd serial-hub-mcp
npm ci
```

让命令进入 PATH（可选）：

```bash
npm link
which serial-hub-mcp serial-hub-server
```

`npm link` 会提供两个命令：

- `serial-hub-mcp` → `src/server.js`
- `serial-hub-server` → `src/hub-server/index.js`

## 3. 启动

### stdio（默认）

```bash
node src/server.js
# 或 npm link 后
serial-hub-mcp
```

stdio 模式没有 Web 页面；它由 MCP 客户端作为子进程启动。

### Streamable HTTP

```bash
SERIAL_HUB_MCP_HTTP_TOKEN=change-me \
  node src/server.js --http --host 0.0.0.0 --port 8787
```

绑定非回环地址但没有 token 时，进程会拒绝启动。确需匿名访问：

```bash
node src/server.js --http --host 0.0.0.0 --allow-anonymous
# 或 SERIAL_HUB_MCP_HTTP_ALLOW_ANONYMOUS=1
```

这只适合隔离的实验网络。

启动后先打开自描述页，确认版本、存储和接入参数：

```bash
curl -s http://127.0.0.1:8787/info              # JSON
open http://127.0.0.1:8787/info?format=html     # 可读页面
```

页面里有可直接粘贴的客户端配置。x86 `serial-hub-server` 同样支持
`http://<hub>:7000/info`（与二进制端口同端口）。

## 4. 接 MCP 客户端

### stdio

```json
{
  "mcpServers": {
    "serial": {
      "command": "node",
      "args": ["/absolute/path/to/serial-hub-mcp/src/server.js"]
    }
  }
}
```

`npm link` 之后可以简化为：

```json
{
  "mcpServers": {
    "serial": { "command": "serial-hub-mcp" }
  }
}
```

### Streamable HTTP

```json
{
  "mcpServers": {
    "serial-hub": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer change-me" }
    }
  }
}
```

不同客户端的 HTTP 配置字段可能略有差异；核心是 URL 加 `Authorization: Bearer <token>`。

## 5. 第一次调用

```text
list_ports()
open({ port: "/dev/ttyUSB0", baud_rate: 115200 })
receive({ connection_id: "...", start: "flush", budget_ms: 5000 })
transact({ connection_id: "...", data: "AT", newline: "crlf", match: "OK" })
close({ connection_id: "..." })
```

要点：

- `open` 返回 `connection_id`，后续工具都用它。
- `receive` 的 `start=flush` 把读游标跳到当前最新字节，只收之后新到的数据；不清缓存。
- `transact` 只关心写入之后到达的字节，适合 AT/Modbus 这类请求-响应。
- 日志按行切分；没有换行的尾巴要等下一行到达后才能 `log_query` 查到。

## 6. 接远端

远端先在 `~/.config/serial-hub-mcp/remotes.json` 注册：

```json
{
  "remotes": [
    {
      "name": "lab-x86",
      "endpoint": "tcp://192.168.1.50:7000",
      "token_env": "LAB_HUB_TOKEN"
    }
  ]
}
```

然后：

```text
list_ports()
open({ remote: "lab-x86", port_id: "ttyACM0", baud_rate: 921600 })
```

也可以不注册，直接传 endpoint 和 token：

```text
open({
  transport: "remote",
  endpoint: "tcp://192.168.4.67:7000",
  token: "...",
  port_id: "uart1",
  baud_rate: 1500000
})
```

远端链路是明文 TCP；只在可信局域网、VPN 或 SSH 隧道里使用。细节见
[remotes.md](remotes.md) 和 [remote-link-protocol-v1.md](remote-link-protocol-v1.md)。

## 7. 数据放在哪

默认（遵循 XDG）：

| 内容                | 默认路径                                               |
| ------------------- | ------------------------------------------------------ |
| 日志、dump、v1 缓存 | `~/.cache/serial-hub-mcp/`                             |
| profile、remotes    | `~/.config/serial-hub-mcp/`                            |
| v2 日志存储         | `~/.cache/serial-hub-mcp/store/local` / `store/remote` |

完整变量见 [configuration.md](configuration.md)。

## 下一步

- [tools.md](tools.md)：每个工具的完整参数和示例。
- [deployment.md](deployment.md)：Docker、systemd、反向代理、Harbor。
- [troubleshooting.md](troubleshooting.md)：打不开端口、日志为空、ECONNREFUSED 等。
