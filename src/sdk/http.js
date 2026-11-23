// MCP over Streamable HTTP（无状态）。
//
// 每个 HTTP 请求构建一个 McpServer + transport（stateless，sessionIdGenerator=undefined），
// 但它们共享外部的 ConnectionManager / LogRouter / queue —— 连接状态跨请求保留。
//
// 鉴权：可选 Bearer token（SERIAL_HUB_MCP_HTTP_TOKEN）。/health 与 /info 免鉴权、不含密钥。

import http from "node:http";
import fs from "node:fs";
import nodePath from "node:path";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Node 18 的 test runner 及部分嵌入上下文不提供全局 WebCrypto；MCP SDK 的
// Streamable HTTP transport 在请求时依赖 crypto.randomUUID()。
if (!globalThis.crypto) globalThis.crypto = crypto.webcrypto;

const DEFAULT_BODY_LIMIT = 4 * 1024 * 1024;

// 自带页面只允许加载这几个 vendor 资源（xterm 相关），不做通用静态目录。
const VENDOR_FILES = new Map([
  ["/vendor/xterm.mjs", ["xterm.mjs", "text/javascript; charset=utf-8"]],
  ["/vendor/addon-fit.mjs", ["addon-fit.mjs", "text/javascript; charset=utf-8"]],
  ["/vendor/xterm.css", ["xterm.css", "text/css; charset=utf-8"]],
]);

function json(res, status, payload) {
  if (!res.headersSent) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  }
  res.end(JSON.stringify(payload));
}

function rpcError(res, status, code, message) {
  if (!res.headersSent) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  }
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function readJsonBody(req, limit = DEFAULT_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`request body too large (> ${limit})`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e.message}`));
      }
    });
    req.on("error", reject);
  });
}

function bearerToken(req) {
  const h = req.headers.authorization;
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * 构建（未监听的）HTTP server。
 * @param {object} opts
 * @param {() => import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} opts.createServer
 * @param {string} [opts.name]
 * @param {string} [opts.path="/mcp"]
 * @param {string} [opts.healthPath="/health"]
 * @param {string} [opts.infoPath="/info"]
 * @param {object|string|Function} [opts.health]
 * @param {object|string|Function} [opts.info]
 * @param {string} [opts.token] Bearer token；为空则不鉴权
 * @param {number} [opts.bodyLimit]
 * @param {string[]} [opts.allowedHosts]
 * @param {string[]} [opts.allowedOrigins]
 * @param {string} [opts.dumpsPath="/dumps/"]
 * @param {(fileId: string) => string|null} [opts.resolveDump]
 * @param {string} [opts.webDir] 自带调试页面目录（提供 index.html）
 * @param {(req, res, url:URL) => Promise<boolean>|boolean} [opts.apiHandler]
 *   `/api/*` 处理器；由调用方完成路由，返回 false 表示未处理
 */
export function createHttpServer(opts = {}) {
  const {
    createServer,
    path = "/mcp",
    healthPath = "/health",
    infoPath = "/info",
    health,
    info,
    token,
    bodyLimit = DEFAULT_BODY_LIMIT,
    allowedHosts,
    allowedOrigins,
    dumpsPath = "/dumps/",
    resolveDump,
    webDir,
    apiHandler,
  } = opts;

  if (typeof createServer !== "function") {
    throw new Error("createHttpServer: createServer 必填");
  }

  const authorized = token ? (req) => safeEqual(bearerToken(req) ?? "", token) : null;

  const handler = async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return rpcError(res, 400, -32700, "bad url");
    }

    try {
      // 免鉴权健康检查（不含密钥）
      if (healthPath && req.method === "GET" && url.pathname === healthPath) {
        const val = typeof health === "function" ? await health(req) : (health ?? { ok: true });
        return json(res, 200, val);
      }
      // 免鉴权自描述（不含密钥）
      if (infoPath && info && req.method === "GET" && url.pathname === infoPath) {
        const val = typeof info === "function" ? await info(req) : info;
        if (typeof val === "string") {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          return res.end(val);
        }
        return json(res, 200, val);
      }
      if (req.method === "GET" && dumpsPath && url.pathname.startsWith(dumpsPath)) {
        if (authorized && !authorized(req)) return rpcError(res, 401, -32001, "Unauthorized");
        const raw = url.pathname.slice(dumpsPath.length);
        if (!raw || raw.includes("/")) return rpcError(res, 404, -32602, "dump not found");
        let fileId;
        try {
          fileId = decodeURIComponent(raw);
        } catch {
          return rpcError(res, 404, -32602, "dump not found");
        }
        const file = typeof resolveDump === "function" ? resolveDump(fileId) : null;
        if (!file) return rpcError(res, 404, -32602, "dump not found");
        const stat = fs.statSync(file);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": stat.size,
          "content-disposition": `attachment; filename="${fileId}"`,
        });
        fs.createReadStream(file).pipe(res);
        return;
      }
      // 自带调试页面：静态、免鉴权、不含密钥
      if (
        webDir &&
        req.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/index.html")
      ) {
        const file = nodePath.join(webDir, "index.html");
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          return rpcError(res, 404, -32602, "ui not found");
        }
        if (!stat.isFile()) return rpcError(res, 404, -32602, "ui not found");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": stat.size,
          "cache-control": "no-cache",
        });
        fs.createReadStream(file).pipe(res);
        return;
      }

      // vendor 静态资源（xterm）：免鉴权，白名单
      if (webDir && req.method === "GET" && VENDOR_FILES.has(url.pathname)) {
        const [name, type] = VENDOR_FILES.get(url.pathname);
        const file = nodePath.join(webDir, "vendor", name);
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          return rpcError(res, 404, -32602, "vendor not found");
        }
        if (!stat.isFile()) return rpcError(res, 404, -32602, "vendor not found");
        res.writeHead(200, {
          "content-type": type,
          "content-length": stat.size,
          "cache-control": "no-cache",
        });
        fs.createReadStream(file).pipe(res);
        return;
      }

      // Web UI 数据接口：与 MCP 共用 Bearer token
      if (apiHandler && url.pathname.startsWith("/api/")) {
        if (authorized && !authorized(req)) return rpcError(res, 401, -32001, "Unauthorized");
        const handled = await apiHandler(req, res, url);
        if (!handled) return rpcError(res, 404, -32601, `not found: ${url.pathname}`);
        return;
      }

      if (url.pathname !== path) return rpcError(res, 404, -32601, `not found: ${url.pathname}`);
      if (authorized && !authorized(req)) return rpcError(res, 401, -32001, "Unauthorized");

      const body = req.method === "POST" ? await readJsonBody(req, bodyLimit) : undefined;
      const mcp = createServer();
      const hasAllowlist = Boolean(allowedHosts?.length || allowedOrigins?.length);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // 无状态
        enableJsonResponse: true,
        ...(hasAllowlist ? { enableDnsRebindingProtection: true } : {}),
        ...(allowedHosts?.length ? { allowedHosts } : {}),
        ...(allowedOrigins?.length ? { allowedOrigins } : {}),
      });
      res.on("close", () => {
        Promise.resolve()
          .then(() => transport.close())
          .catch(() => {})
          .then(() => mcp.close())
          .catch(() => {});
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      rpcError(res, 500, -32603, String((err && err.message) || err));
    }
  };

  return http.createServer((req, res) => void handler(req, res));
}

/**
 * 启动并监听。返回 { server, port }；handleSignals=false 时（测试）不接管进程信号。
 * @param {object} opts createHttpServer 的参数 + host/port/onShutdown/handleSignals
 */
export async function runHttp(opts = {}) {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8787;
  const path = opts.path ?? "/mcp";
  const server = createHttpServer(opts);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const boundPort = server.address().port;
  const ui = opts.webDir ? `；调试页面 http://${host}:${boundPort}/` : "";
  process.stderr.write(
    `[${opts.name ?? "mcp"}] MCP server 启动（Streamable HTTP: http://${host}:${boundPort}${path}${ui}）\n`,
  );

  if (opts.handleSignals !== false) {
    const shutdown = async (code = 0) => {
      try {
        await new Promise((r) => server.close(r));
      } catch (_) {
        /* ignore */
      }
      if (opts.onShutdown) {
        try {
          await opts.onShutdown();
        } catch (_) {
          /* ignore */
        }
      }
      process.exit(code);
    };
    process.on("SIGINT", () => void shutdown(0));
    process.on("SIGTERM", () => void shutdown(0));
  }

  return { server, port: boundPort };
}
