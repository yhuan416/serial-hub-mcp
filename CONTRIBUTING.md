# Contributing

Thanks for taking a look. This project is small and deliberately boring at the byte
level — keep it that way.

## Development

```bash
npm install
npm test        # unit tests + stdio/HTTP smoke; no serial hardware required
npm run lint    # eslint + prettier check
npm run smoke   # MCP handshake + tool enumeration only
npm run smoke:http
```

Both transports must keep working: stdio (`runStdio`) and stateless Streamable HTTP
(`runHttp`). The HTTP handler builds a fresh MCP server per request but shares the
connection manager, log router and queue.

Node.js >= 18 is required. On Linux you do **not** need a serial device to run the tests
(they use a fake link).

## Guidelines

- The data plane is **byte-transparent**. Do not add framing, echo, line rewriting or
  prompt/regex interpretation there; content judgement belongs to the agent.
- `Connection` must stay transport-agnostic. It only depends on the port duck type
  (`on('data'|'error'|'close')`, `open/close/write/drain/flush/set`, `path`).
- New transports are added through the registries:
  - local link: `registerLink(name, factory)` in `src/links/index.js`
  - remote scheme: `registerRemoteScheme(scheme, connector)` in `src/links/remote.js`;
    a connector establishes the link, performs `HELLO`, and returns `{ rpc, info }`.
- `Connection` (local) and `RemoteConnection` (`src/remote/connection.js`) expose the same
  method surface used by the tools. The v0 remote protocol is exercised end-to-end with the
  in-process `test-utils/fake_bridge.js`; extend it when adding RPCs.
- Keep tool schemas documented in `defineTool` (`name/title/description/inputSchema/handler`)
  and return `{ ok: true, response }`; throw for business errors.
- Run `npm run format` before opening a PR.

## Releasing

```bash
npm version patch|minor|major
npm publish
git push --follow-tags
```

Create a matching release note from `CHANGELOG.md`.