# Changelog

All notable changes to this project are documented here.

## 0.1.0

Initial open-source release.

- **Two transports**: stdio (default) and stateless MCP Streamable HTTP (`--http`), with optional
  Bearer auth (`SERIAL_HUB_MCP_HTTP_TOKEN`) and unauthenticated `/health` + `/info`.
- 19 MCP tools: connection lifecycle, byte I/O (`read`/`write`/`transact`/`receive`/`dump_to_file`),
  control lines (`set_dtr_rts`/`send_break`), profiles, log retrieval and `log_export`.
- Byte-transparent data plane with absolute consume cursor, cross-chunk matching, bounded RX
  buffer and drop accounting.
- Per-connection durable logs: in-memory ring, JSONL partitions, retention eviction, query by
  seq/time/direction/content/order.
- Hub skeleton: per-`connection_id` serialization with cross-connection concurrency, log
  backend routing (`LogRouter`), and link abstraction (`src/links/`).
- Public remote-link contract (v0) for ESP32-style bridges: `open({transport:"remote", endpoint})`
  plus the HELLO/READ/TRANSACT/LOG_* RPC specification.
- **Host-side TCP remote link implemented**: NDJSON RPC, HELLO token auth, on-demand pull
  (`READ` long-poll), device-side `offset` cursors, `TRANSACT` barrier, control lines/BREAK,
  and `receive`/`dump_to_file` mapped onto the RPC. ESP32 firmware is not included yet.
- In-process v0 **fake bridge** (`test-utils/fake_bridge.js`) and end-to-end tests.
- **RemoteLogStore + log_export**: remote `log_query/log_stats/log_clear` proxy the device's
  authoritative RAM/SD log; `log_export` pages `LOG_EXPORT` (raw+index) into a host file,
  distinct from live `dump_to_file`.
- Device SD support: the companion `serial-hub-bridge` firmware writes `raw-rx/tx` +
  `idx-rx/tx` with fsync/retention and implements `LOG_EXPORT`.
- Endpoint scheme registry (`registerRemoteScheme`); `tcp` implemented, `udp/kcp/mqtt/ws` planned.
- Data compression is reserved for v1 (negotiated, adaptive; see protocol doc).
- Zero private dependencies: built directly on `@modelcontextprotocol/sdk`, `serialport`, `zod`.