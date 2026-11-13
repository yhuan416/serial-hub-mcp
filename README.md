# serial-hub-mcp

中文说明：[README.zh.md](README.zh.md)。

A serial-port MCP server that is also a **hub**: one process can hold multiple local
UARTs plus remote serial endpoints — either an ESP32-S3 wireless dongle or an
**x86/Linux `serial-hub-server`** that exposes all of its local serial ports.

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
- **Configured remotes**: register remotes once in `~/.config/serial-hub-mcp/remotes.json`
  (or `SERIAL_HUB_MCP_REMOTES`); `list_ports` aggregates local + all remote port lists in
  parallel, and `open({remote:"name"})` resolves endpoint/token for you.
- **Hub-ready concurrency**: calls are serialized per `connection_id` and run concurrently
  across different connections.
- **Remote link (TCP)**: `open({transport:"remote", endpoint:"tcp://host:port"})` speaks the
  binary push protocol. The device only keeps unacked bytes; the host splits lines and
  owns `log_query`. Firmware lives in `serial-hub-bridge`.
- **x86 remote hub-server** (`serial-hub-server`): deploy on a Linux box to expose
  `ttyUSB*/ttyACM*`. Node.js (`src/hub-server`) plus a Docker image
  (`docker/serial-hub-server.Dockerfile`). See [x86 hub-server](docs/x86-hub-server.md).
- **Remote auth**: the bridge requires a HELLO token once configured (NVS-generated per
  device or `CONFIG_BRIDGE_AUTH_TOKEN`); pass it as `open({token})`. Plaintext, so use a
  trusted LAN or a VPN/SSH tunnel.

> Status: `0.1.x` — local serial, the binary TCP remote link, and the x86
> `serial-hub-server` are implemented. The ESP32-S3 firmware lives in `serial-hub-bridge`.

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
| `list_ports` | Enumerate local ports and probe each configured remote |
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
| `log_export` / `log_sync` | Copy host log lines to a file. The host cache is the log; the device is only a send buffer |
| `event_query` | Query remote control-plane events when the bridge still records them |
| `cache_set` | Persist a remote send-cache size in device NVS |
| `service_info` | Service name, version, changelog |

## Quick start

```text
list_ports()                     // 本机 + 所有已配置 remote 的端口
open({ remote: "lab-x86", port_id: "ttyACM0", baud_rate: 921600 })
open({ port: "/dev/ttyUSB0", baud_rate: 115200, newline: "crlf" })
transact({ connection_id: "...", data: "AT", match: "OK" })
receive({ connection_id: "...", start: "flush", reset: "dtr", budget_ms: 15000 })
dump_to_file({ connection_id: "...", budget_ms: 30000 })
close({ connection_id: "..." })
```

For remote hubs:

```text
// ESP32-S3 bridge
open({ transport: "remote", endpoint: "tcp://esp32s3-01:7000", token: "<token>", port_id: "uart1" })
// x86 hub-server（port_id 为串口 basename，也接受 /dev/ttyACM0）
open({ transport: "remote", endpoint: "tcp://192.168.1.50:7000", token: "<token>", port_id: "ttyACM0", baud_rate: 921600 })
transact({ connection_id: "...", data: "AT", match: "OK" })
receive({ connection_id: "...", budget_ms: 5000, idle_timeout_ms: 300 })
```

`endpoint` is `tcp://host:port`. `port_id` selects a device port when the bridge exposes
more than one; `token` is sent in the `HELLO` frame. The bridge
prints its NVS-generated token once at boot (`bridge_auth: auth token from NVS: ...`) and
includes it in the provisioning QR when provisioning is active.

### Remote log semantics

The host splits BATCH payloads on `\n` and assigns `seq`. `log_query` reads that cache.
The device does not keep a line index for the TCP session. `gap=true` means bytes were
lost before they reached the host. `log_clear` with no `connection_id` requires
`confirm:true`.

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
- Each log entry is `{ seq, ts, conn, dir, offset, line, hex, bytes }`. Remote `seq` is
  assigned by the host, not by the device.

## Design

- [Hub architecture](docs/hub-architecture.md) — early layering notes. The protocol doc wins
  where they disagree.
- [x86 hub-server](docs/x86-hub-server.md) — deploy a multi-port remote serial service on
  Linux (systemd unit included).
- [Configured remotes](docs/remotes.md) — remotes.json / env, aggregated `list_ports`,
  `open({remote})`.
- [Remote link protocol](docs/remote-link-protocol-v1.md) — binary push, BATCH, ACK,
  host-side cache. Server in `src/hub-server/v1.js`; host client in
  `src/remote/v1_connection.js`.

## Development

```bash
npm install
npm test          # unit tests + stdio/HTTP smoke (no hardware required)
npm run lint      # eslint + prettier check
npm run smoke     # MCP handshake + tool enumeration only
npm run smoke:http
```

Remote-link tests start an in-process hub over TCP. They need neither hardware nor network access.

## License

MIT. See [LICENSE](LICENSE).