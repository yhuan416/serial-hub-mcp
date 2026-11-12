# Changelog

All notable changes to this project are documented here.

## Unreleased

- Dual UART: UART1 (17/18, `uart1`) and UART2 (4/5, `uart2`); per-port
  ring/RAM/SD namespace, `port_id` routing and concurrent TCP sessions.
- Shared SD writer queue with per-port generation; `LOG_*`/`read`/`write` select
  a port per request. NTP time base is per port/segment.

- NTP/SNTP wall-clock timestamps: `HELLO/LOG_STATS.time` reports `epoch_ms/synced/source`;
  remote log entries carry epoch `ts` with `ts_source:"ntp"`; NTP sync seals the pre-sync
  segment and starts a segment with a persisted `epoch_base_ms`; `LOG_EXPORT`/host export
  expose the time base.

- No-loss pipeline groundwork: UART RX/TX no longer performs SD I/O; lines/TX writes are
  queued in a 3 MiB PSRAM queue and written raw+index by a dedicated task. Queue drops and
  UART overflow are counted and emitted as `sd.queue_drop`/`uart.overflow` events.
- SD logs flush unterminated RX lines every sync interval; retention now deletes complete
  segments (not individual raw/index files).
- `LOG_STATS` adds health counters (`rx_bytes`, `tx_bytes`, `uart_overflow_*`, `sd_queue`);
  `read/receive/dump/transact` surface `gap`/`gap_bytes`/ring bounds.
- New `log_sync` collector: incremental segment/dir export to host with persisted watermarks
  and resumable export pages. Remote stores auto-run it every 60 s by default.
- Device `LOG_ACK` + per-segment ack files: retention deletes only fully archived segments;
  forced unarchived deletion only below 256 MiB free (`sd.retention_unacked`).
- Active segment repair on resume: truncate invalid index tails and index orphan raw bytes
  (`sd.repair`) after crashes/power loss.

- Remote `log_query` fixes: `order:"desc"` now starts from the newest RAM window and returns
  a usable older-page cursor; `ram_earliest_seq` and `sd_earliest_seq` are reported
  separately; `contains`/`regex` page through the RAM window (bounded) instead of filtering
  only the first page.
- Queries/stats/clear without `connection_id` now aggregate local and all remote backends.
  Full clear requires `confirm:true`; remote `log_clear` accepts `segment`.
- SD segment persistence: resume the newest complete segment on boot/remount, scan/expose
  `segments[]`, export by `segment`, clear all or one segment, and rotate at
  `CONFIG_BRIDGE_SD_SEGMENT_MAX_MB`.
- Remote auth: NVS-generated per-device token (or Kconfig override), constant-time HELLO
  check, token included in the provisioning QR/log. v0 remains plaintext; use VPN/SSH.

## 0.1.0

Initial open-source release.

- **Two transports**: stdio (default) and stateless MCP Streamable HTTP (`--http`), with optional
  Bearer auth (`SERIAL_HUB_MCP_HTTP_TOKEN`) and unauthenticated `/health` + `/info`.
- 20 MCP tools: connection lifecycle, byte I/O (`read`/`write`/`transact`/`receive`/`dump_to_file`),
  control lines (`set_dtr_rts`/`send_break`), profiles, log retrieval, `log_export` and `event_query`.
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
- **event_query**: remote control-plane events (SD mount/remount/write errors, ring
  drops) via `EVENT_QUERY`; SD/ring faults no longer only exist as counters.
- Endpoint scheme registry (`registerRemoteScheme`); `tcp` implemented, `udp/kcp/mqtt/ws` planned.
- Data compression is reserved for v1 (negotiated, adaptive; see protocol doc).
- Zero private dependencies: built directly on `@modelcontextprotocol/sdk`, `serialport`, `zod`.