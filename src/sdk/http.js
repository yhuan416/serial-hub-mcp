// MCP over Streamable HTTP（无状态）。
//
// 每个 HTTP 请求构建一个 McpServer + transport（stateless，sessionIdGenerator=undefined），
// 但它们共享外部的 ConnectionManager / LogRouter / queue —— 连接状态跨请求保留。
//
// 鉴权：可选 Bearer token（SERIAL_HUB_MCP_HTTP_TOKEN）。/health 与 /info 免鉴权、不含密钥。

import http from "node:http";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const DEFAULT_BODY_LIMIT = 4 * 1024 * 1024;

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
      if (url.pathname !== path) return rpcError(res, 404, -32601, `not found: ${url.pathname}`);
      if (authorized && !authorized(req)) return rpcError(res, 401, -32001, "Unauthorized");

      const body = req.method === "POST" ? await readJsonBody(req, bodyLimit) : undefined;
      const mcp = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // 无状态
        enableJsonResponse: true,
        ...(allowedHosts ? { allowedHosts } : {}),
        ...(allowedOrigins ? { allowedOrigins } : {}),
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
  process.stderr.write(
    `[${opts.name ?? "mcp"}] MCP server 启动（Streamable HTTP: http://${host}:${boundPort}${path}）\n`,
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
