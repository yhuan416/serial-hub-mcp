# Development

## 环境

```bash
git clone https://github.com/yhuan416/serial-hub-mcp.git
cd serial-hub-mcp
npm ci
```

Node.js >= 18。CI 覆盖 18 / 20 / 22；Docker 镜像使用 Node 22 LTS。

## 常用命令

```bash
npm test          # 单测 + stdio/HTTP smoke，不需要硬件
npm run lint      # eslint + prettier check
npm run smoke     # 只做 MCP 握手和工具枚举
npm run smoke:http
npm run format    # prettier --write
```

远端测试在进程内起一个真实 TCP hub，不依赖设备或外网。

## 代码结构

```text
src/server.js            MCP 入口（stdio / HTTP）
src/connection.js        本地连接、RX 缓冲、read/transact/receive
src/tools/               MCP 工具：conn / log / profile
src/remote/              v1 帧编解码与 host 侧客户端
src/hub-server/          x86 serial-hub-server
src/links/               本机串口链路
src/sdk/                 MCP tool 注册、HTTP、结果封装
src/web/                 网页终端（xterm）
docker/                  MCP / hub / n100 compose 与 Dockerfile
docs/                    协议、配置、部署、排障
test/                    单测与 smoke
```

`package.json` 的 `bin`：

- `serial-hub-mcp` → `src/server.js`
- `serial-hub-server` → `src/hub-server/index.js`

不要移动这两个入口。

## 测试约定

- 单元测试尽量注入 fake link / fake serial，不碰真实硬件。
- v1 相关测试起进程内 hub，覆盖 HELLO、SUBSCRIBE、BATCH、ACK、GAP、resume、lease。
- HTTP smoke 覆盖 Bearer、tools/list、service_info、`/health`。
- Web UI smoke 覆盖静态页、SSE、`/api/input` 绕过队列。
- Node 18 的 test runner 不提供全局 WebCrypto；`src/sdk/http.js` 会补
  `globalThis.crypto = crypto.webcrypto`，不要删掉。

## CI

`.github/workflows/ci.yml` 在 push `master` 和 PR 时跑：

1. `npm ci`
2. `npm run lint`
3. `npm test`（Node 18/20/22 矩阵）

测试失败时，workflow 会把第一个 `not ok` 的用例块输出成 check-run annotation，方便在公开
API 里定位，不需要仓库 admin 权限下载日志。

## 发布

以 `0.3.4` 为例。

### 1. 版本与 changelog

```bash
npm version 0.3.4 --no-git-tag-version
```

把 `CHANGELOG.md` 的 `## Unreleased` 内容移到 `## 0.3.4 — YYYY-MM-DD`，保留新的空
`## Unreleased`。

### 2. 验证

```bash
npm test
npm run lint
```

至少本地跑一遍 Node 18 和当前 LTS；CI 会再覆盖 18/20/22。

### 3. 提交与 tag

```bash
git add -A
git commit -m "release: 0.3.4"
git tag -a v0.3.4 -m "serial-hub-mcp 0.3.4"
git push origin master v0.3.4
```

如果远端 master 有新提交，先 merge/rebase 再 push；tag 只打在发布提交上。

### 4. 构建并推送镜像

```bash
docker build -f docker/serial-hub-mcp.Dockerfile \
  -t harbor.example.com/ipcs/serial-hub-mcp:0.3.4 .
docker push harbor.example.com/ipcs/serial-hub-mcp:0.3.4
```

如果同时改了 `serial-hub-server`，用
`docker/serial-hub-server.Dockerfile` 构建并推同名仓库。

### 5. 部署

```bash
docker rm -f serial-hub-mcp
docker run -d --name serial-hub-mcp --restart unless-stopped \
  --add-host=host.docker.internal:host-gateway \
  -p 8788:8787 \
  -e SERIAL_HUB_MCP_HTTP_TOKEN="$(cat ~/.config/serial-hub-mcp/http.token)" \
  -v ~/.local/share/serial-hub-mcp:/data \
  -v ~/.config/serial-hub-mcp:/config:ro \
  harbor.example.com/ipcs/serial-hub-mcp:0.3.4
```

部署会断开当前内存里的串口会话；日志和游标在 `/data`，重开可续。

### 6. 冒烟

```bash
curl -s http://127.0.0.1:8788/health
curl -s http://127.0.0.1:8788/info                    # JSON：版本、部署、存储、限额
curl -s 'http://127.0.0.1:8788/info?format=html'      # 页面：可直接转给同事
```

再调一次 `service_info` 和 `list_ports`。确认版本、工具数、远端来源，以及 `/info`
里的部署/存储与预期一致。

### 7. 回滚

保留上一版镜像 tag。回滚就是把 `docker run` 的镜像换回 `0.3.1`；`/data` 不需要动。
README / Harbor / git tag 三处的版本号要一致。

## 协议变更

改 v1 线格式时：

1. 先改 `docs/remote-link-protocol-v1.md`，明确字段和兼容性。
2. 改 `src/remote/v1_codec.js`。
3. 同时改 host（`src/remote/v1_connection.js`）和 hub（`src/hub-server/v1.js`）。
4. 补 `test/v1_*.unit.js` 和 `test/hub_server_v1.unit.js`。
5. 不兼容改动升协议版本，不要偷偷改字段含义。

## GitHub 仓库设置

- Description / Homepage / Topics 用 `gh repo edit` 维护。
- Releases 用 tag 创建，正文取 `CHANGELOG.md` 对应段落；最新版本标 Latest。
- Social preview 需要在 **Settings → General → Social preview** 手动上传
  [`docs/assets/social-preview.png`](assets/social-preview.png)（1280×640）。
- README 顶部截图是 [`docs/assets/web-ui.png`](assets/web-ui.png)，来自 `--http` 的网页界面。
- 自描述页截图是 [`docs/assets/info-page.png`](assets/info-page.png)（900×630，只截部署段），
  来自 `GET /info?format=html`；换数据时重截，不要只改说明文字。

## 文档

- 新文档放 `docs/`，并在 `docs/README.md` 加索引。
- 相对链接以仓库根目录为基准。
- 环境变量默认值以代码为准；新增变量时同时更新
  [configuration.md](configuration.md) 和两份 README 的常用表。
- `README.md` 和 `README.zh.md` 保持相同章节结构，只翻译正文。
