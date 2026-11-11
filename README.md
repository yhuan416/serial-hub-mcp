# serial-hub-mcp

A serial-port MCP server that is also a **hub**: one process can hold multiple local
UARTs and (in upcoming releases) remote serial bridges such as an ESP32-S3 acting as a
wireless UART dongle.

The byte plane is intentionally boring and transparent: bytes in, bytes out, no framing,
no prompt/regex interpretation. Content judgement is left to the agent. Logs are split by
line for retrieval, but the raw hex is always the source of truth.

## Features

- **Two transports**: `stdio` (default) and stateless **MCP Streamable HTTP** (`--http`), with
  optional Bearer auth plus unauthenticated `/health` and `/info` endpoints.
- **Local serial** via [`serialport`](https://serialport.io/): `list_ports`, open by path,
  profile, `sn`/`vid`/`pid`, configurable baud/parity/flow control.
- **Byte-accurate I/O**: `read` (cat), `transact` (write + wait, ignores pre-write noise),
  `receive` (windowed capture), `dump_to_file` (stream to disk).
- **Control lines**: DTR/RTS (with pulse for reset sequences) and BREAK.
- **Durable logs**: per-connection in-memory ring + JSONL partitions on disk, queryable by
  seq/time/direction/content, with retention and eviction reporting.
- **Profiles**: save connection parameters and reuse them with `open({profile})`.
- **Hub-ready concurrency**: calls are serialized per `connection_id` and run concurrently
  across different connections.
- **Remote link (TCP)**: `open({transport:"remote", endpoint:"tcp://host:port"})` speaks the
  v0 NDJSON RPC contract (`HELLO/READ/TRANSACT/LOG_*`) to an ESP32-style bridge. On-demand
  pull, device-side offsets, and a `transact` barrier that excludes pre-write bytes.
  Remote `log_query/log_stats/log_clear` proxy the device via `RemoteLogStore`,
  `log_export` pulls the device SD history into a host file (separate from live
  `dump_to_file`), `log_sync` incrementally archives SD segments with host watermarks,
  and `event_query` surfaces device control-plane events. Queries without
  `connection_id` aggregate local + all remote connections. `test-utils/fake_bridge.js`
  covers the wire contract; the ESP32 firmware lives in `serial-hub-bridge`.
  Other schemes (`ws/udp/kcp/mqtt`) plug in via the scheme registry.
- **Remote auth**: the bridge requires a HELLO token once configured (NVS-generated per
  device or `CONFIG_BRIDGE_AUTH_TOKEN`); pass it as `open({token})`. v0 is still plaintext,
  so use a trusted LAN or a VPN/SSH tunnel.

> Status: `0.1.x` — local serial and the TCP remote link are implemented; the ESP32-S3
> firmware (`serial-hub-bridge`) supports SD segment resume, auth, events and 4 MiB ring.
> Extra transports (`ws/udp/kcp/mqtt`) are next.

## Install

```bash
npm install -g serial-hub-mcp
# or run without installing
npx serial-hub-mcp
```

Requirements: Node.js >= 18. On Linux, add your user to the `dialout` group (or otherwise
grant read access to `/dev/ttyUSB*`, `/dev/ttyACM*`).

## MCP client configuration

### stdio (default)

```json
{
  "mcpServers": {
    "serial": {
      "command": "serial-hub-mcp"
    }
  }
}
```

### Streamable HTTP

Start the server with `--http`, then point clients at the MCP endpoint. The exact client
config shape varies; for clients that accept a URL and headers:

```json
{
  "mcpServers": {
    "serial-hub": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## HTTP mode

```bash
serial-hub-mcp --http                      # 127.0.0.1:8787/mcp
serial-hub-mcp --http --host 0.0.0.0 --port 8787
SERIAL_HUB_MCP_HTTP_TOKEN=secret serial-hub-mcp --http
```

- Stateless Streamable HTTP: every request gets its own MCP server instance while sharing the
  same connection manager / log router / queue, so connections persist across requests.
- `GET /health` and `GET /info` are unauthenticated and contain no secrets.
- The server listens on loopback by default. If you bind a non-loopback address **without**
  `SERIAL_HUB_MCP_HTTP_TOKEN`, it prints a warning — anyone who can reach the port can operate
  the serial ports.
- The token is compared with a constant-time check and sent as `Authorization: Bearer <token>`.

## Tools

| Tool | Purpose |
|---|---|
| `list_ports` | Enumerate local serial ports (path, VID/PID, serial number) |
| `open` | Open a connection (`transport` / `port` / `profile` / `sn|vid|pid` / `endpoint`) |
| `close` | Close a connection |
| `get_status` | Connection state, counters, control-line levels |
| `write` | Send bytes (utf8 / hex / base64, optional newline) |
| `read` | Read bytes since the cursor (optional wait / match / min bytes) |
| `transact` | Write then wait for a response in one step (AT/Modbus friendly) |
| `receive` | Capture a window until match / max bytes / idle / budget |
| `dump_to_file` | Stream RX to a file (live capture; no large payloads through MCP) |
| `set_dtr_rts` | Set DTR/RTS, optionally pulse (reset/bootloader) |
| `send_break` | Send a BREAK for a given duration |
| `profile_list/save/delete` | Reusable named connection profiles |
| `log_query/stats/clear` | Search, inspect and clear logs (no `connection_id` = local + remote) |
| `log_export` | Export a remote device's authoritative SD log to a host file (segment/seq/dir paged) |
| `log_sync` | Incrementally archive all new SD seq to a host directory with persisted watermarks |
| `event_query` | Query remote control-plane events (SD mount/remount/write errors, ring drops, UART/SD queue loss) |
| `service_info` | Service name, version, changelog |

## Quick start

```text
list_ports()
open({ port: "/dev/ttyUSB0", baud_rate: 115200, newline: "crlf" })
transact({ connection_id: "...", data: "AT", match: "OK" })
receive({ connection_id: "...", start: "flush", reset: "dtr", budget_ms: 15000 })
dump_to_file({ connection_id: "...", budget_ms: 30000 })
close({ connection_id: "..." })
```

For remote hubs:

```text
open({ transport: "remote", endpoint: "tcp://esp32s3-01:7000", token: "<token>" })
transact({ connection_id: "...", data: "AT", match: "OK" })
receive({ connection_id: "...", budget_ms: 5000, idle_timeout_ms: 300 })
```

`endpoint` chooses the transport: `tcp://` is implemented; `ws/udp/kcp/mqtt` are planned and
plug in through `registerRemoteScheme(scheme, connector)`. `port_id` selects a device port
when the bridge exposes more than one; `token` is sent in the `HELLO` frame. The bridge
prints its NVS-generated token once at boot (`bridge_auth: auth token from NVS: ...`) and
includes it in the provisioning QR when provisioning is active.

### Remote log semantics

- `log_query` `order:"desc"` starts from the newest RAM entries; `ram_earliest_seq` is the
  oldest live-window entry, while `sd_earliest_seq`/`log_stats.segments[]` describe the SD
  segment(s). They are different seq spaces.
- `contains`/`regex` scan up to 20 RAM pages (bounded); they are not a full SD search. Use
  `log_export` for historical full-text work. `time_from/time_to` are not pushed down to the
  device yet; inspect `time_source`/`ts_source` before relying on them.
- `line`/`hex` in `log_query` are capped by the device (`log_line_max_bytes`, default 192);
  `bytes` is the full length. `log_export` writes the raw bytes.
- `log_stats.segments[]` lists every segment with `first_seq/latest_seq/active`; `log_export`
  accepts `segment` to export a specific segment (default: active).
- `log_sync` is the collector: it exports all new seq per segment/dir into
  `~/.cache/serial-hub-mcp/remote-sync/<endpoint>/`, keeps `state.json` watermarks, and is
  safe to call repeatedly. Remote stores auto-run it every `SERIAL_HUB_MCP_AUTO_SYNC_MS`
  (default 60 s; `0` disables); manual calls are serialized behind auto ones.
- After a segment/dir is fully exported, `log_sync` sends `LOG_ACK`; the device only
  retention-deletes acknowledged segments. If the card gets critically full, it force-deletes
  the oldest unarchived segment with `sd.retention_unacked`.
- `log_stats` exposes loss/health counters: `rx_bytes`, `tx_bytes`, `uart_overflow_*`,
  `ring.dropped_bytes`, `sd_write_errors`, `sd_queue.dropped*`, and `sd_broken`. A healthy
  powered link should keep `uart_overflow_bytes=0`, `sd_queue.dropped=0`, and
  `ring.dropped_bytes=0`.
- `read/receive/dump_to_file/transact` include `gap`, `gap_bytes`, `ring_start_offset`,
  `ring_end_offset`, and (where applicable) `next_offset`; `gap=true` means the live ring
  lost bytes and you should export SD history.
- `log_clear` with no `connection_id` requires `confirm:true` and clears local + all remote
  current logs; remote `segment` limits the clear to one segment.

## Configuration

All paths use XDG defaults and can be overridden:

| Env var | Default | Purpose |
|---|---|---|
| `SERIAL_HUB_MCP_LOGS_DIR` | `$XDG_CACHE_HOME/serial-hub-mcp/logs` | Log partitions |
| `SERIAL_HUB_MCP_LOG_MEM` | `1000` | In-memory log entries per process |
| `SERIAL_HUB_MCP_LOG_RETAIN_BYTES` | `67108864` (64 MiB/conn) | Disk retention; `<=0` disables eviction |
| `SERIAL_HUB_MCP_LOG_PART_BYTES` | `8388608` (8 MiB) | Partition roll size |
| `SERIAL_HUB_MCP_PROFILES_DIR` | `$XDG_CONFIG_HOME/serial-hub-mcp` | Profiles |
| `SERIAL_HUB_MCP_DUMPS_DIR` | `$XDG_CACHE_HOME/serial-hub-mcp/dumps` | `dump_to_file` output |
| `SERIAL_HUB_MCP_SYNC_DIR` | `$XDG_CACHE_HOME/serial-hub-mcp/remote-sync` | `log_sync` archive root |
| `SERIAL_HUB_MCP_AUTO_SYNC_MS` | `60000` | remote auto `log_sync` interval; `0` disables |
| `SERIAL_HUB_MCP_HTTP` | unset | `1` enables HTTP mode (same as `--http`) |
| `SERIAL_HUB_MCP_HTTP_HOST` | `127.0.0.1` | HTTP bind host |
| `SERIAL_HUB_MCP_HTTP_PORT` | `8787` | HTTP bind port |
| `SERIAL_HUB_MCP_HTTP_PATH` | `/mcp` | MCP endpoint path |
| `SERIAL_HUB_MCP_HTTP_HEALTH_PATH` | `/health` | Health endpoint (unauthenticated) |
| `SERIAL_HUB_MCP_HTTP_INFO_PATH` | `/info` | Service info endpoint (unauthenticated) |
| `SERIAL_HUB_MCP_HTTP_TOKEN` | unset | Optional Bearer token for `/mcp` |

## Data and log model

- RX is accumulated in a chunked buffer with an absolute consume cursor. The buffer is
  bounded (`rx_buffer_size`, 4 MiB default); the oldest bytes are dropped and counted in
  `rx_dropped`.
- Logs are line-oriented for retrieval (`\n`, trailing `\r` stripped); TX is recorded once
  per write. Non-UTF-8 content is still available as raw hex.
- Remote capture is decoupled: the UART task only enqueues lines into a PSRAM queue; a
  lower-priority writer task does SD raw+index I/O. Queue/overflow loss is counted/evented.
- When the device has SNTP sync, `LOG_QUERY` entries carry epoch `ts` and per-entry
  `ts_source:"ntp"`; otherwise they carry uptime ticks (`ts_source:"tick"`). NTP sync also
  seals the pre-sync segment and starts a time-anchored segment (`LOG_STATS.epoch_base_ms`).
- Each log entry is `{ seq, ts, conn, dir, offset, line, hex, bytes }`. `seq` is per log
  source; the hub never renumbers it. For remote SD history, seq is **per segment**;
  `log_stats.segments[]` gives each segment's range and `log_export` takes `segment`.
- Remote SD logs resume the newest complete segment on boot/remount; segment rotation is
  controlled by `CONFIG_BRIDGE_SD_SEGMENT_MAX_MB` (default 3072) to stay below FAT32's 4 GiB
  per-file limit.

## Design

- [Hub architecture](docs/hub-architecture.md) — layering, pull-only data flow, per-source
  sequencing, durable-log authority, concurrency, endpoint registry plan.
- [Remote link protocol](docs/remote-link-protocol.md) — host ↔ ESP32 bridge RPC contract
  (READ/TRANSACT/LOG_*), framing, sequence/offset semantics, error codes.

## Development

```bash
npm install
npm test          # unit tests + stdio/HTTP smoke (no hardware required)
npm run lint      # eslint + prettier check
npm run smoke     # MCP handshake + tool enumeration only
npm run smoke:http
```

The remote-link tests start an in-process v0 bridge (`test-utils/fake_bridge.js`) over TCP,
so they need neither hardware nor network access.

## License

MIT. See [LICENSE](LICENSE).