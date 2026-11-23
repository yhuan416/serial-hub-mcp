# Storage and logs

`serial-hub-mcp` 的日志模型是 **host 侧权威**：远端只保留没被 ACK 的字节，切行、`seq`、检索和
持久化都在 host 完成。

## 字节与行

- RX 到达后先进入连接的字节缓冲（分块数组 + 绝对消费游标），`read` / `transact` 消费后释放。
- 同时把字节喂给日志后端，按 `\n` 切行；行尾 `\r` 会去掉。
- 没有换行的尾巴是 **partial line**，留在内存里，等下一块到达再拼；`log_query` 暂时查不到。
- TX 每调用一次 `write` 记一条，不切行。
- 每条日志是 `{ seq, ts, conn, dir, offset, line, hex, bytes }`；`seq` 由 host 分配，远端 DATA
  帧里的 seq 无效（恒为 0）。
- 非 UTF-8 内容以 hex 为准；`line` 只是可读视图。

## v2 store（默认）

`SERIAL_HUB_MCP_STORE=v2` 时使用 `HostLogStore`：

- 行记录写二进制 segment，记录带 CRC 和 offset。
- SQLite(WAL) 只存 segment/block 索引和统计，不存大块 payload。
- 查询按 `seq` / 时间裁剪 block，只读需要的块。
- segment 默认 16 MiB 轮转；block 索引粒度 1 MiB；默认 500 ms 批量落盘。
- 每连接默认保留 512 MiB，超过后按字节淘汰；同时受 7 天 TTL 约束。
- 崩溃后启动时恢复尾段，截断无效索引。
- 本地连接和远端 v1 host 缓存使用同一个引擎，但分目录：
  - `store/local`
  - `store/remote`

这样 `LogRouter` 做全量查询时不会把同一批远端日志重复计入。

| 变量                                 | 默认                                          |
| ------------------------------------ | --------------------------------------------- |
| `SERIAL_HUB_MCP_STORE`               | `v2`                                          |
| `SERIAL_HUB_MCP_STORE_DIR`           | `$XDG_CACHE_HOME/serial-hub-mcp/store/local`  |
| `SERIAL_HUB_MCP_REMOTE_STORE_DIR`    | `$XDG_CACHE_HOME/serial-hub-mcp/store/remote` |
| `SERIAL_HUB_MCP_STORE_RETAIN_BYTES`  | 512 MiB/连接                                  |
| `SERIAL_HUB_MCP_STORE_SEGMENT_BYTES` | 16 MiB                                        |
| `SERIAL_HUB_MCP_STORE_BLOCK_BYTES`   | 1 MiB                                         |
| `SERIAL_HUB_MCP_STORE_FLUSH_MS`      | 500                                           |

## legacy JSONL

`SERIAL_HUB_MCP_STORE=legacy` 回到旧实现：内存 ring + JSONL 分片。

| 变量                              | 默认                                  |
| --------------------------------- | ------------------------------------- |
| `SERIAL_HUB_MCP_LOGS_DIR`         | `$XDG_CACHE_HOME/serial-hub-mcp/logs` |
| `SERIAL_HUB_MCP_LOG_MEM`          | 1000                                  |
| `SERIAL_HUB_MCP_LOG_RETAIN_BYTES` | 64 MiB/连接                           |
| `SERIAL_HUB_MCP_LOG_PART_BYTES`   | 8 MiB                                 |

旧 JSONL **不会**自动导入 v2。要查旧数据，临时切 `legacy`，或者用旧版本导出。

## 查询语义

`log_query` 只查 host 缓存，不向设备要历史：

- 不传 `time_from` / `seq_from` 会从缓存里还留着的最早一行开始，可能早于本次观察。
- 只想看开始观察之后的：先取当前 epoch ms，再传 `time_from`。
- `dir`、`seq` 范围、`time` 范围、`contains`、`regex`、`order`、`limit`、`cursor` 都可用。
- 省略 `connection_id` 时聚合本地和所有远端 host 缓存。
- `include_hex` 默认关闭以减少响应；二进制排查时再打开。

`log_clear` 清 host 日志；省略 `connection_id` 时必须 `confirm:true`。远端只清 host 缓存，不清设备。

## dump 与下载

`dump_to_file` 导出 **已有** 缓存，不读新数据，不移动 read 游标：

```text
dump_to_file({ connection_id, time_from, time_to })
dump_to_file({ connection_id, seq_from, seq_to })
dump_to_file({ connection_id, offset_from, offset_to })
```

返回 `file_id` / `sha256` / `download_path`。文件放在 `SERIAL_HUB_MCP_DUMPS_DIR`，通过
`GET /dumps/<file_id>` 下载，Bearer token 与 `/mcp` 相同。

要边看边录，先 `dump_to_file` 留档，再用 `read` / `receive` 继续消费。

## TTL 与保留

`SERIAL_HUB_MCP_CACHE_TTL_DAYS`（默认 7）会清理日志、dump、v1 捕获缓存和 remote-sync：

- `0` 关闭 TTL 清理。
- opens、cursors、profiles 不在这条 TTL 里。
- 要长期保存，`dump_to_file` 后下载到 agent 本机。

远端 hub-server 自己的 ring/capture 不受这里控制；它的保留参数见
[x86-hub-server.md](x86-hub-server.md)。

## 为什么远端不存历史

协议 v1 明确 `history: "none"`，`HISTORY_*` 返回 `unsupported`。远端只是发送缓存：

- 未被 ACK 的字节不能静默丢；要丢先发 `GAP`。
- ACK 之后可以立即释放。
- 跨重启不要求保留。

正确性依赖 host 自己已有的字节，不依赖远端历史。详见
[remote-link-protocol-v1.md](remote-link-protocol-v1.md)。
