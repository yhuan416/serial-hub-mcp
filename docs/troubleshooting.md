# Troubleshooting

先做四个检查：

```text
service_info()
get_status()
log_stats()
```

```bash
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/info
docker logs --tail 100 serial-hub-mcp
```

`/health` 和 `/info` 不含密钥，可以直接看。

## HTTP / 鉴权

| 现象                                                     | 原因                                    | 处理                                                                                                   |
| -------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 启动即退出，提示“拒绝启动：绑定非回环地址…未设置 token”  | 0.3.2 起非回环地址默认 fail-closed      | 设置 `SERIAL_HUB_MCP_HTTP_TOKEN`，或显式 `--allow-anonymous` / `SERIAL_HUB_MCP_HTTP_ALLOW_ANONYMOUS=1` |
| `/mcp` 返回 401                                          | Bearer token 不对/缺失                  | `Authorization: Bearer <token>`，token 看 `mcp.env`、`_FILE` 或容器环境                                |
| `/mcp` 返回 403 `Invalid Host header` / `Invalid Origin` | 访问用的主机名/端口不在 allowlist       | 用 `127.0.0.1` / `localhost` 访问，或设置 `SERIAL_HUB_MCP_HTTP_ALLOWED_HOSTS` / `_ORIGINS`（含端口）   |
| 启动报“无法读取 HTTP token” / `..._FILE`                 | token 文件缺失、不可读或为空            | 检查 `SERIAL_HUB_MCP_HTTP_TOKEN_FILE` 路径和 0600 权限；或直接设 `SERIAL_HUB_MCP_HTTP_TOKEN`           |
| `/api/*` 返回 401                                        | Web UI 数据接口也要 token               | 页面里输入同一个 token                                                                                 |
| `/dumps/<id>` 401/404                                    | token 不对，或 file_id 过期/被 TTL 清理 | 重新 `dump_to_file`；确认 `SERIAL_HUB_MCP_DUMPS_DIR`                                                   |
| 页面能开但一直连不上                                     | 反向代理缓冲了 SSE                      | 代理关闭缓冲，保留 `text/event-stream`                                                                 |
| 绑定 `0.0.0.0` 后本机 curl 不通                          | 端口被占用/防火墙                       | `ss -ltnp \| grep 8787`，检查安全组                                                                    |

## 本机串口

| 现象                                       | 原因                               | 处理                                                                       |
| ------------------------------------------ | ---------------------------------- | -------------------------------------------------------------------------- |
| `open` 报 `EACCES` / permission denied     | 用户不在 `dialout`，或设备权限不对 | `sudo usermod -aG dialout "$USER"`，重新登录；容器检查 `group_add: ["20"]` |
| `list_ports` 本机为空，带 `udevadm ENOENT` | 精简容器没有 udevadm               | MCP 中心容器本来就不挂串口；本机端口由 `serial-hub-server` 暴露            |
| `open` 报“未找到匹配串口”                  | `sn/vid/pid` 不匹配                | 先 `list_ports()` 看真实字段                                               |
| 读到的全是乱码                             | 波特率/校验/流控不对               | 用正确参数重新 `open`；远端可先 `CONFIG`                                   |
| 打开后设备被复位                           | DTR/RTS 默认电平触发               | 检查 `set_dtr_rts` 和硬件接线                                              |
| 写入成功但设备无反应                       | 换行不对                           | `write/transact` 加 `newline: "crlf"` 或 `"lf"`                            |

## 日志

| 现象                         | 原因                                 | 处理                                         |
| ---------------------------- | ------------------------------------ | -------------------------------------------- |
| `log_query` 为空             | 还没有完整的一行，或缓存被清         | 先 `receive` / 等换行；`log_stats` 看条数    |
| 只有 TX 没有 RX              | 设备没发数据/波特率不对              | 用 `receive({start:"flush"})` 观察；检查接线 |
| 查询结果比预期早             | 没传 `time_from`，从缓存最早一行开始 | 先取当前 epoch ms，再传 `time_from`          |
| `dump_to_file` 0 字节        | 指定范围内没有缓存                   | 换 `time_from` / `offset`，或先收一段        |
| `log_clear` 报需要 `confirm` | 全量清理保护                         | 传 `confirm: true`                           |
| 升级后旧日志看不到           | 从 `legacy` 切到了 v2                | 旧 JSONL 不会自动导入；临时切 `legacy` 查询  |
| SQLite 报锁/损坏             | 多个进程共用同一 store 目录          | 一个目录只给一个 MCP 进程；先停进程再备份    |

## 远端链路

| 现象/错误码                 | 含义                                  | 处理                                                                                                               |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ECONNREFUSED` / `连接超时` | hub 没起、地址/端口不对、容器网络不通 | 先 `list_ports({remote:"..."})`；容器用 `host.docker.internal` 时加 `--add-host=host.docker.internal:host-gateway` |
| `unauthorized`              | HELLO token 不符                      | 对比 `<data-dir>/token` / `SERIAL_HUB_SERVER_TOKEN`                                                                |
| `port_not_found`            | `--ports` 过滤掉了，或设备已拔出      | 看 `HELLO_ACK.ports`；检查 `--ports` 和 `/dev`                                                                     |
| `not_controller`            | 已有 writer，当前 session 只读        | `open({claim_writer:true})` 抢写权，或先关掉旧 writer                                                              |
| `capture_expired`           | capture 已过期                        | host 会自动去掉 `from` 新建；旧缓存仍在，只是 offset 接不上                                                        |
| `gap=true` / `gap_bytes>0`  | 远端丢了一段未 ACK 字节               | 看 `gap_from_offset` / `gap_to_offset`；加大 window/capture 缓存                                                   |
| `reconnecting:true`         | socket 断了，正在指数退避重连         | `read/receive` 等缓存；控制命令会快速失败 `reconnecting`                                                           |
| `resume_lost`               | 旧 capture 过期，已新建               | 不影响 host 已有日志；后续 offset 从新 capture 算                                                                  |
| `lease_expired`             | 会话租约到                            | 重新 `open`；capture 可能还在                                                                                      |
| `busy`                      | 远端暂时不能加 session                | 稍后重试                                                                                                           |
| `history unsupported`       | 远端不是日志库                        | 正常；查 host 缓存，不要向设备要历史                                                                               |

远端链路是明文 TCP；跨公网请走 VPN/SSH。协议细节见
[remote-link-protocol-v1.md](remote-link-protocol-v1.md)。

## Docker

| 现象                                              | 原因                                          | 处理                                                             |
| ------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| 容器里看不到 `/dev/ttyACM*`                       | 只绑了单个 `--device`，或节点没插             | 绑定 `/dev`，用 `device_cgroup_rules` 放行 `c 166:*` / `c 188:*` |
| 看得到节点但打不开                                | cgroup 没放行或不在 `dialout`                 | 检查 `device_cgroup_rules` 和 `group_add: ["20"]`                |
| `SerialPort.list()` 没厂商信息                    | 没挂 `/run/udev`                              | `-v /run/udev:/run/udev:ro`                                      |
| 容器健康检查失败                                  | 端口/路径不对，或启动被 token 策略拒绝        | `docker logs` 看启动日志；`/health` 是否 200                     |
| 容器启动即退出，日志报 `EACCES` / `/data`         | bind mount 目录对容器内 node(uid 1000) 不可写 | `sudo chown -R 1000:1000 <宿主目录>`，或改用 named volume        |
| hub 启动报无法读取 `SERIAL_HUB_SERVER_TOKEN_FILE` | token 文件缺失、不可读或为空                  | 检查 secret 挂载路径与 0600 权限；或改用 `<data-dir>/token`      |
| MCP 连不到本机 hub                                | 用了容器内 `localhost`                        | 用 `host.docker.internal:7000`（加 host-gateway）或实际 IP       |
| 容器重启后会话没了                                | 连接是进程内状态                              | 重新 `open`；日志/游标在 `/data`，可续传                         |

## 性能与内存

| 现象                         | 处理                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| 高波特率下 `rx_dropped` 增长 | 加大 `rx_buffer_size`；用 `receive` 及时消费；远端加大 ring/capture                             |
| 页面卡顿/事件太多            | 服务端已按 ~80ms 合并；关闭不用的 tab，或 `SERIAL_HUB_MCP_HTTP_UI=0`                            |
| store 目录涨得快             | 调低 `SERIAL_HUB_MCP_STORE_RETAIN_BYTES` / `SERIAL_HUB_MCP_CACHE_TTL_DAYS`；定期下载需要的 dump |
| 查询慢                       | 用 `time_from` / `seq_from` 缩小范围；v2 会比 legacy JSONL 快很多                               |

## 还解决不了

收集这些信息再开 issue：

```text
service_info()
get_status()
log_stats()
```

- `node -v`、部署方式（stdio/HTTP/Docker）、MCP 客户端版本。
- 相关 `docker logs` / `serial-hub-server` 启动日志。
- 出错工具的完整返回（token 已打码，可以直接贴）。
