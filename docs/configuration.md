# Configuration

所有配置都可以用环境变量覆盖。CLI 参数（`--http` / `--host` / `--port` / `--path` /
`--allow-anonymous`）优先于同名环境变量。

路径默认遵循 XDG：

| 变量              | 默认        |
| ----------------- | ----------- |
| `XDG_CACHE_HOME`  | `~/.cache`  |
| `XDG_CONFIG_HOME` | `~/.config` |

## MCP host

### 路径与数据

| 变量                              | 默认                                             | 说明                                   |
| --------------------------------- | ------------------------------------------------ | -------------------------------------- |
| `SERIAL_HUB_MCP_LOGS_DIR`         | `$XDG_CACHE_HOME/serial-hub-mcp/logs`            | `STORE=legacy` 时的 JSONL 日志分片     |
| `SERIAL_HUB_MCP_LOG_MEM`          | `1000`                                           | 每进程内存日志条数                     |
| `SERIAL_HUB_MCP_LOG_RETAIN_BYTES` | `67108864`（64 MiB/连接）                        | 旧日志磁盘保留；`<=0` 不淘汰           |
| `SERIAL_HUB_MCP_LOG_PART_BYTES`   | `8388608`（8 MiB）                               | 旧日志分片轮转大小                     |
| `SERIAL_HUB_MCP_OPENS_FILE`       | `$XDG_CACHE_HOME/serial-hub-mcp/opens.json`      | `open_list` 索引                       |
| `SERIAL_HUB_MCP_PROFILES_DIR`     | `$XDG_CONFIG_HOME/serial-hub-mcp`                | `profiles.json` 所在目录               |
| `SERIAL_HUB_MCP_DUMPS_DIR`        | `$XDG_CACHE_HOME/serial-hub-mcp/dumps`           | `dump_to_file` 输出                    |
| `SERIAL_HUB_MCP_CACHE_TTL_DAYS`   | `7`                                              | 日志、dump、捕获缓存保留天数；`0` 关闭 |
| `SERIAL_HUB_MCP_SYNC_DIR`         | `$XDG_CACHE_HOME/serial-hub-mcp/remote-sync`     | 旧 remote-sync 缓存                    |
| `SERIAL_HUB_MCP_V1_CACHE_DIR`     | `$XDG_CACHE_HOME/serial-hub-mcp/v1-cache`        | 未启用 v2 store 时的 v1 host 缓存      |
| `SERIAL_HUB_MCP_V1_STATE_FILE`    | `$XDG_CACHE_HOME/serial-hub-mcp/v1-cursors.json` | v1 续传游标                            |

### 远端注册表

优先级从高到低：

1. `SERIAL_HUB_MCP_REMOTES`：内联 JSON 字符串
2. `SERIAL_HUB_MCP_REMOTES_FILE`：文件路径
3. `$XDG_CONFIG_HOME/serial-hub-mcp/remotes.json`

| 变量                          | 默认                                           | 说明              |
| ----------------------------- | ---------------------------------------------- | ----------------- |
| `SERIAL_HUB_MCP_REMOTES`      | 未设置                                         | 内联 remotes JSON |
| `SERIAL_HUB_MCP_REMOTES_FILE` | `$XDG_CONFIG_HOME/serial-hub-mcp/remotes.json` | 远端注册表文件    |

格式和字段见 [remotes.md](remotes.md)。

### HTTP

| 变量                                  | 默认        | 说明                                                    |
| ------------------------------------- | ----------- | ------------------------------------------------------- |
| `SERIAL_HUB_MCP_HTTP`                 | 未设置      | `1` 启用 HTTP（等价 `--http`）                          |
| `SERIAL_HUB_MCP_HTTP_HOST`            | `127.0.0.1` | 绑定地址                                                |
| `SERIAL_HUB_MCP_HTTP_PORT`            | `8787`      | 绑定端口                                                |
| `SERIAL_HUB_MCP_HTTP_PATH`            | `/mcp`      | MCP 端点路径                                            |
| `SERIAL_HUB_MCP_HTTP_HEALTH_PATH`     | `/health`   | 健康检查，免鉴权                                        |
| `SERIAL_HUB_MCP_HTTP_INFO_PATH`       | `/info`     | 服务信息，免鉴权                                        |
| `SERIAL_HUB_MCP_HTTP_TOKEN`           | 未设置      | **密钥。** `/mcp`、`/api/*`、`/dumps/*` 的 Bearer token |
| `SERIAL_HUB_MCP_HTTP_UI`              | `1`         | `0` 关闭网页调试界面                                    |
| `SERIAL_HUB_MCP_HTTP_ALLOW_ANONYMOUS` | 未设置      | `1` 允许非回环地址无 token 启动（**危险**）             |

绑定非回环地址且没有 token 时，进程拒绝启动。放行方式：

```bash
serial-hub-mcp --http --host 0.0.0.0 --allow-anonymous
# 或
SERIAL_HUB_MCP_HTTP_ALLOW_ANONYMOUS=1 serial-hub-mcp --http --host 0.0.0.0
```

回环地址（`127.0.0.1` / `localhost` / `::1`）不设 token 仍然可以启动。

### v2 store

`SERIAL_HUB_MCP_STORE` 默认 `v2`。v2 用二进制 segment 存行记录，SQLite(WAL) 只存
segment/block 索引；`legacy` 回到旧的 JSONL 实现。

| 变量                                 | 默认                                          | 说明                               |
| ------------------------------------ | --------------------------------------------- | ---------------------------------- |
| `SERIAL_HUB_MCP_STORE`               | `v2`                                          | `v2` 或 `legacy`                   |
| `SERIAL_HUB_MCP_STORE_DIR`           | `$XDG_CACHE_HOME/serial-hub-mcp/store/local`  | 本地连接 v2 目录                   |
| `SERIAL_HUB_MCP_REMOTE_STORE_DIR`    | `$XDG_CACHE_HOME/serial-hub-mcp/store/remote` | 远端 v1 host 缓存目录              |
| `SERIAL_HUB_MCP_STORE_RETAIN_BYTES`  | 512 MiB/连接                                  | 每连接磁盘上限；`<=0` 不按字节淘汰 |
| `SERIAL_HUB_MCP_STORE_SEGMENT_BYTES` | 16 MiB                                        | 单段大小                           |
| `SERIAL_HUB_MCP_STORE_BLOCK_BYTES`   | 1 MiB                                         | block 索引粒度                     |
| `SERIAL_HUB_MCP_STORE_FLUSH_MS`      | 500                                           | 批量落盘间隔                       |

旧 JSONL 不会自动导入；要看旧数据先切 `legacy`。实现细节见 [storage.md](storage.md)。

## x86 hub-server

`serial-hub-server` 读取下列变量；命令行参数优先。完整参数与部署说明见
[x86-hub-server.md](x86-hub-server.md)。

| 变量                                  | 默认                                       | 说明                                       |
| ------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| `SERIAL_HUB_SERVER_TOKEN`             | 自动生成 `<data-dir>/token`（0600）        | **密钥。** HELLO 鉴权 token                |
| `SERIAL_HUB_SERVER_LISTEN`            | `0.0.0.0:7000`                             | 监听地址                                   |
| `SERIAL_HUB_SERVER_DATA_DIR`          | `~/.local/share/serial-hub-server`         | 数据与 token 目录                          |
| `SERIAL_HUB_SERVER_PORTS`             | `/dev/ttyUSB,/dev/ttyACM,/dev/serial/,COM` | 端口路径子串或 `/regex/`；空字符串暴露全部 |
| `SERIAL_HUB_SERVER_RING_BYTES`        | `64MiB`                                    | 每端口环形缓冲                             |
| `SERIAL_HUB_SERVER_RETENTION_BYTES`   | `4GiB`                                     | 每端口磁盘保留                             |
| `SERIAL_HUB_SERVER_CAPTURE_LINGER_MS` | `60000`                                    | 最后一个会话离开后 capture 保留时间        |
| `SERIAL_HUB_SERVER_CAPTURE_MAX_BYTES` | `128MiB`                                   | 单 capture 发送缓存上限                    |
| `SERIAL_HUB_SERVER_WINDOW_BYTES`      | `256KiB`                                   | 默认每 session 窗口                        |
| `SERIAL_HUB_SERVER_MAX_WINDOW_BYTES`  | `1MiB`                                     | 每 session 窗口上限                        |
| `SERIAL_HUB_SERVER_LEASE_MS`          | `120000`                                   | session 租约超时                           |

## 示例

### 本机 HTTP + token

```bash
SERIAL_HUB_MCP_HTTP_TOKEN="$(openssl rand -hex 32)" \
  node src/server.js --http --host 0.0.0.0 --port 8787
```

### 容器内固定目录

```bash
XDG_CONFIG_HOME=/config \
XDG_CACHE_HOME=/data \
SERIAL_HUB_MCP_REMOTES_FILE=/config/remotes.json \
SERIAL_HUB_MCP_PROFILES_DIR=/data/profiles \
SERIAL_HUB_MCP_OPENS_FILE=/data/opens.json \
SERIAL_HUB_MCP_DUMPS_DIR=/data/dumps \
node src/server.js --http
```

### 用环境变量给远端 token

```json
{
  "remotes": [
    {
      "name": "lab",
      "endpoint": "tcp://192.168.1.50:7000",
      "token_env": "LAB_HUB_TOKEN"
    }
  ]
}
```

```bash
export LAB_HUB_TOKEN="$(cat /var/lib/serial-hub-server/token)"
```

## 密钥

- `SERIAL_HUB_MCP_HTTP_TOKEN`、`SERIAL_HUB_SERVER_TOKEN` 和 `remotes.json` 里的 token 都是敏感值。
- 工具返回值、`profile_list`、`open_list` 里的 token 会打码；文件里仍是原值。
- 优先用 `token_env`，不要把 token 写进镜像或命令行历史。
- 远端链路和 HTTP 都是明文；只在可信 LAN/VPN/SSH 隧道里使用。
