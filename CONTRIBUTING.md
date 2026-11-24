# Contributing

Thanks for taking a look. This project is small and deliberately boring at the byte level —
keep it that way.

## Development

```bash
npm ci
npm test        # unit tests + stdio/HTTP smoke; no serial hardware required
npm run lint    # eslint + prettier check
npm run smoke   # MCP handshake + tool enumeration only
npm run smoke:http
npm run format
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
- New local transports are added with `registerLink(name, factory)` in `src/links/index.js`.
  Remote sessions are opened by `ConnectionManager` via `src/remote/v1_connection.js`.
- Remote protocol tests use the in-process hub (`test/hub_server_v1.unit.js`,
  `test/v1_host.unit.js`).
- Tool definitions live in `defineTool` and include `name`, `title`, `description`,
  `inputSchema`, all four `annotations` hints (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`), and `handler`. Return `{ ok: true, response }`;
  throw for business errors.
- Update `docs/tools.md` and `docs/configuration.md` when adding a tool or environment
  variable. Keep `README.md` and `README.zh.md` structurally aligned.

## Commit messages

Use Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `perf:`, `test:`, `ci:`,
`chore:`, and `release:` for version bumps. Scopes are optional (`feat(info): ...`), and `!`
marks a breaking change.

`npm run changelog` turns commits since the last tag into a grouped Markdown draft (Chinese
section titles, short hashes). It only reads git and prints to stdout; edit the result into
`CHANGELOG.md` instead of pasting it verbatim.

## Releasing

The release checklist lives in [docs/development.md](docs/development.md#发布): version bump,
changelog, tests, git tag, Harbor image, deployment, and rollback. The package is not
published on npm yet; do not add an `npm publish` step until that changes.
