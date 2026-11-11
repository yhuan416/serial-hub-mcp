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
- **Remote link seam**: `open({transport:"remote", endpoint:"tcp://host:port"})` is part of
  the public contract. The RPC contract is defined; the ESP32 bridge adapter is not yet
  implemented.

> Status: `0.1.x` — local serial is production-ready; the remote bridge contract and
> endpoint registry are landing incrementally.

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
| `dump_to_file` | Stream RX to a file (no large payloads through MCP) |
| `set_dtr_rts` | Set DTR/RTS, optionally pulse (reset/bootloader) |
| `send_break` | Send a BREAK for a given duration |
| `profile_list/save/delete` | Reusable named connection profiles |
| `log_query/stats/clear` | Search, inspect and clear per-connection logs |
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
open({ transport: "remote", endpoint: "tcp://esp32s3-01:7000" })
```

`endpoint` is the reserved slot for the link adapters. The planned registry maps endpoint
schemes (`tcp`, `udp`, `kcp`, `mqtt`, `ws`, ...) to adapters; see the design docs.

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
- Each log entry is `{ seq, ts, conn, dir, offset, line, hex, bytes }`. `seq` is per log
  source; the hub never renumbers it.

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

## License

MIT. See [LICENSE](LICENSE).