# Changelog

All notable changes to this project are documented here.

## 0.1.0

Initial open-source release.

- 18 MCP tools: connection lifecycle, byte I/O (`read`/`write`/`transact`/`receive`/`dump_to_file`),
  control lines (`set_dtr_rts`/`send_break`), profiles and log retrieval.
- Byte-transparent data plane with absolute consume cursor, cross-chunk matching, bounded RX
  buffer and drop accounting.
- Per-connection durable logs: in-memory ring, JSONL partitions, retention eviction, query by
  seq/time/direction/content/order.
- Hub skeleton: per-`connection_id` serialization with cross-connection concurrency, log
  backend routing (`LogRouter`), and link abstraction (`src/links/`).
- Public remote-link contract for ESP32-style bridges: `open({transport:"remote", endpoint})`
  plus the READ/TRANSACT/LOG_* RPC specification. The adapter itself is not implemented yet.
- Endpoint registry design for future `tcp`/`udp`/`kcp`/`mqtt` transports.
- Zero private dependencies: built directly on `@modelcontextprotocol/sdk`, `serialport`, `zod`.