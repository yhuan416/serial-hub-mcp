# 串口 Hub 架构

早期笔记，不再作为实现依据。现行契约是 [remote-link-protocol-v1.md](./remote-link-protocol-v1.md)。

现行分工：

- 设备只留未被 ACK 的发送缓存，BATCH 推原始字节。
- host 切行、分配 seq、落盘、检索。
- `history_query` 回 `unsupported`。没有 NDJSON，也没有设备侧日志权威。
