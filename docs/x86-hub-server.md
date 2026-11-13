# x86 远端串口服务（serial-hub-server）

ESP32-S3 桥受限于 RAM/Flash：单端口、256 KiB 级环形缓冲、SD 卡索引扫描慢，
部署与扩容也不方便。本服务把「远端」下沉到一台 x86/Linux 机器（或任意 Node.js
可运行的机器），把该机器上的串口通过二进制帧暴露给 `serial-hub-mcp`。

```
┌──────────────┐   TCP / SH frames   ┌──────────────────────────┐
│ serial-hub-  │ ◄─────────────────► │ serial-hub-server (x86)  │
│ mcp (host)   │   7000/tcp, token   │  ├ /dev/ttyUSB0           │
└──────────────┘                     │  └ /dev/ttyACM0           │
                                     └──────────────────────────┘
```

## 1. 安装与启动

依赖 Node.js >= 18（与 MCP 相同），`serialport` 为仓库依赖。

```bash
cd serial-hub-mcp
npm install

# 前台启动（首次会在 data-dir 生成 token 文件，0600）
node src/hub-server/index.js --listen 0.0.0.0:7000 \
  --data-dir /var/lib/serial-hub-server \
  --ports /dev/ttyUSB,/dev/ttyACM --ring-bytes 128MiB
```

启动输出示例：

```
[serial-hub-server] v0.1.0 listening on 0.0.0.0:7000
[serial-hub-server] data-dir=/var/lib/serial-hub-server token-file=/var/lib/serial-hub-server/token
[serial-hub-server] ports=2 (ttyACM1, ttyACM0)
```

token 读取顺序：`--token` > `SERIAL_HUB_SERVER_TOKEN` > `<data-dir>/token`（不存在则生成）。

## 2. 常用参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--listen` | `0.0.0.0:7000` | 监听地址；只本机用建议 `127.0.0.1:7000` |
| `--token` | 自动生成 | HELLO 鉴权 token（建议走环境变量/文件，别写进命令行历史） |
| `--data-dir` | `~/.local/share/serial-hub-server` | 日志/状态目录 |
| `--ports` | `/dev/ttyUSB,/dev/ttyACM,/dev/serial/,COM` | 逗号分隔的路径子串或 `/re/`；`--ports ""` 关闭过滤=暴露全部 |
| `--ring-bytes` | `64MiB` | 每端口环形缓冲（可按字节或 `128MiB`） |
| `--segment-bytes` | `64MiB` | 单段日志上限 |
| `--retention-bytes` | `4GiB` | 每端口磁盘保留上限 |
| `--retention-days` | `7` | 按天数淘汰旧段 |
| `--ram-entries` | `20000` | RAM 窗口条数（LOG_QUERY 可见范围） |
| `--max-frame` | `1MiB` | 单帧 JSON 上限（x86 可以比 ESP32 放宽） |
| `--max-hold-ms` | `30000` | READ 长轮询硬上限 |
| `--scan-interval-ms` | `2000` | 端口热插拔扫描周期 |
| `--baud` | `115200` | 新端口默认波特率 |

环境变量同名映射：`SERIAL_HUB_SERVER_TOKEN/LISTEN/DATA_DIR/PORTS/RING_BYTES/RETENTION_BYTES`。

## 3. Docker 部署

```bash
cd serial-hub-mcp
cp docker/serial-hub-server.env.example docker/serial-hub-server.env
# 编辑 token
docker compose -f docker/docker-compose.hub.yml up -d --build
docker logs -f serial-hub-server
```

镜像已推送到 Harbor：`harborcn.fujikam.com:14743/ipcs/serial-hub-server:0.1.5`（`latest` 同 digest）。

n100（讯美 wifi/dsp 两路 ttyACM）可直接用：
```bash
docker compose -f docker/docker-compose.n100.yml up -d   # 自动 pull Harbor 镜像
```

- 镜像：`docker/serial-hub-server.Dockerfile`（node:22-slim）。
- 串口通过 `devices:` + `group_add: ["20"]`（dialout）暴露；动态插拔可改 `privileged: true`。
- 容器内 `/sys` 与宿主机共享，`SerialPort.list()` 可能列出未映射的串口；服务以 `/dev`
  节点是否存在为准过滤，所以只有 `--device` 映射进来的端口会出现在 `INFO.ports`。
- 挂载 `/run/udev:/run/udev:ro` 才能读到厂商/序列号/VID/PID（否则只有 path/id）。
- v1 参数可用环境变量：`SERIAL_HUB_SERVER_CAPTURE_LINGER_MS`、
  `SERIAL_HUB_SERVER_CAPTURE_MAX_BYTES`、`SERIAL_HUB_SERVER_WINDOW_BYTES`、
  `SERIAL_HUB_SERVER_MAX_WINDOW_BYTES`、`SERIAL_HUB_SERVER_LEASE_MS`。
- 数据目录 `/data` 挂到命名卷，token 通过 `env_file`（0600）注入。
- 容器内默认 `--ports /dev/ttyUSB,/dev/ttyACM,/dev/serial/`。

## 4. 用 MCP 连接

```text
serial-hub_open(
  transport = "remote",
  endpoint  = "tcp://<x86-host>:7000",
  token     = "<token>",
  port_id   = "ttyACM0",          # 服务端 INFO.ports 里的 id（basename）
  baud_rate = 115200
)
```

`port_id` 也接受完整路径 `/dev/ttyACM0`。后续 `read/receive/write/transact/
dump_to_file/log_query/log_stats/log_export` 等工具全部可用。

## 6. 相比 ESP32 桥的增强

- **多端口**：一个服务暴露整机串口，MCP 侧按 `port_id` 选路。
- **大缓冲**：每端口默认 64 MiB ring（可调），921600/1.5M/3M 波特率下不易丢字节。
- **更大帧**：`max_frame` 默认 1 MiB。
- **热插拔**：定期重扫，USB 串口插拔后自动出现在端口列表。

## 7. 行为说明

- 日志在 host 切行后检索，不在远端建索引。
- 明文，只在内网或 VPN 使用。
- `LOG_CLEAR` 不带 segment = 清空全部并把 seq 归零；带 segment 只删该段。
- 写日志顺序：分配 `tx_offset` → 落日志 → 写串口（与桥一致）。

## 8. systemd 部署

见 `docs/deploy/serial-hub-server.service`：

```bash
sudo cp docs/deploy/serial-hub-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now serial-hub-server
sudo cat /var/lib/serial-hub-server/token     # 取 token 填到 MCP
```

建议：

- 只在内网/VPN 使用（v0 明文，无 TLS）。
- `--ports` 限定真实在用的串口，避免把 `ttyS*` 全部暴露。
- 运行用户加入 `dialout` 组（Debian/Ubuntu）。
- 磁盘保留按现场日志量调整（`--retention-bytes/--retention-days`）。

## 8. 链路

只接受二进制帧（魔数 `SH`）。非 `SH` 首字节直接断开。

- 实现：`src/hub-server/v1.js`。契约见 [`remote-link-protocol-v1.md`](./remote-link-protocol-v1.md)。
- 数据面只发 BATCH。ACK 后释放发送缓存。
- 参数：`--capture-linger-ms`（默认 60000）、`--capture-max-bytes`（默认 128 MiB）、
  `--window-bytes`（256 KiB）、`--max-window-bytes`（1 MiB）、`--lease-ms`（30000）。
- MCP：`open({ remote:"n100", port_id:"ttyACM0" })`。`read/log_query` 走本地缓存。

## 10. 排障

| 现象 | 排查 |
|---|---|
| `unauthorized` | token 不一致（看 `<data-dir>/token`） |
| `port_not_found` | `INFO.ports` 里没有该 id；检查 `--ports` 过滤、用户权限 |
| 读到的全是乱码 | 波特率不对；用 `CONFIG` 重新下发 |
| 日志为空 | 端口尚未有数据；先 `CONFIG` 打开端口 |
| `LOG_EXPORT` 很慢 | 段索引很大；缩小 `--segment-bytes` 或按 `seq_from` 限定 |