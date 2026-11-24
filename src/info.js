// serial-hub-mcp 的 /info 数据：部署 / 存储 / 限制 / 端点 / 接入步骤。
//
// 同一份数据喂给两处，字段必须一致：
//   - MCP 工具 service_info
//   - HTTP GET /info（默认 JSON；?format=html 或浏览器 Accept 时返回页面）
//
// 页面免鉴权，因此这里只放“部署形态”信息：不读 token、不读 remotes 里的 endpoint/token。

import { dirStats, formatBytes, resolvePublicUrl } from "./sdk/info-page.js";

const MIB = 1024 * 1024;
const SUMMARY =
  "串口 MCP 中心：本机 UART + 远端 hub（ESP32-S3 / x86），字节透明收发与连接级持久日志。";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function loopbackBase(host, port) {
  if (!host || !LOOPBACK.has(String(host))) return null;
  return `http://${host}:${port}`;
}

function dirInfo(dir) {
  const st = dirStats(dir);
  if (!st) return "尚未创建";
  const size = `${st.files} 个文件 · ${formatBytes(st.sizeBytes)}`;
  return st.truncated ? `${size}（仅统计前 ${st.entries} 项）` : size;
}

function bytesOrUndefined(value) {
  return value === undefined || value === null ? undefined : formatBytes(value);
}

/**
 * @param {object} ctx
 * @param {string} ctx.version
 * @param {"v2"|"legacy"} [ctx.storeMode]
 * @param {object} [ctx.paths] localStore/remoteStore/logs/dumps/sync/v1Cache/profiles/opens
 * @param {object} [ctx.storeOptions] retainBytes/segmentBytes/blockBytes/flushMs
 * @param {number} [ctx.cacheTtlDaysValue]
 * @param {object} [ctx.http] host/port/path/healthPath/infoPath/uiEnabled/tokenRequired/anonymousAllowed
 * @param {number} [ctx.toolsCount]
 * @param {{count:number,names:string[]}} [ctx.remotes]
 * @param {number} [ctx.startedAtMs]
 * @param {object} [ctx.env]
 * @param {{headers?: object}} [ctx.req] 仅用于推导 publicUrl
 * @returns {object} 与 /info JSON 相同的对象（不含 changelog，由 buildServiceInfo 补）
 */
export function buildMcpInfo(ctx = {}) {
  const {
    version = "unknown",
    storeMode = "v2",
    paths = {},
    storeOptions = {},
    cacheTtlDaysValue,
    http = {},
    toolsCount,
    remotes,
    startedAtMs = Date.now(),
    env = process.env,
    req,
  } = ctx;
  const base = loopbackBase(http.host, http.port);
  const publicUrl = resolvePublicUrl({
    envUrl: env.SERIAL_HUB_MCP_PUBLIC_URL,
    req,
    fallback: base,
  });
  const transport = http.host ? "http" : "stdio";
  const uptimeSeconds = Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));
  const tokenRequired = Boolean(http.tokenRequired);

  const deployment = {
    runtime: `node ${process.version}`,
    platform: `${process.platform} ${process.arch}`,
    transport,
    startedAt: new Date(startedAtMs).toISOString(),
    uptimeSeconds,
  };
  if (env.SERIAL_HUB_IMAGE) deployment.image = env.SERIAL_HUB_IMAGE;
  if (env.NODE_ENV) deployment.nodeEnv = env.NODE_ENV;
  if (transport === "http") {
    if (publicUrl) deployment.publicUrl = publicUrl;
    deployment.listen = `${http.host}:${http.port}`;
    deployment.ui = http.uiEnabled ? "on" : "off";
    deployment.auth = tokenRequired
      ? "Bearer token（/health、/info 免鉴权）"
      : http.anonymousAllowed
        ? "无 token（显式允许匿名）"
        : "无 token（仅回环绑定）";
  }

  const storage = { mode: storeMode };
  if (storeMode === "legacy") {
    storage.logs = paths.logs;
    storage.logsSize = dirInfo(paths.logs);
  } else {
    storage.localStore = paths.localStore;
    storage.localStoreSize = dirInfo(paths.localStore);
    storage.remoteStore = paths.remoteStore;
    storage.remoteStoreSize = dirInfo(paths.remoteStore);
  }
  storage.dumps = paths.dumps;
  storage.dumpsSize = dirInfo(paths.dumps);
  storage.syncDir = paths.sync;
  storage.v1Cache = paths.v1Cache;
  storage.profiles = paths.profiles;
  storage.opens = paths.opens;
  storage.cacheTtlDays = cacheTtlDaysValue;

  const limits = {
    bodyBytes: formatBytes(4 * MIB),
    tools: toolsCount,
    remotes: remotes?.count,
    remoteNames: remotes?.names?.length ? remotes.names.join("、") : remotes ? "（无）" : undefined,
    // v2 的每连接保留；legacy 用 LOG_RETAIN_BYTES，默认 64 MiB
    retainBytes: bytesOrUndefined(
      storeOptions.retainBytes ?? (storeMode === "legacy" ? 64 * MIB : 512 * MIB),
    ),
    segmentBytes: bytesOrUndefined(
      storeOptions.segmentBytes ?? (storeMode === "legacy" ? 8 * MIB : 16 * MIB),
    ),
    blockBytes: storeMode === "v2" ? bytesOrUndefined(storeOptions.blockBytes ?? MIB) : undefined,
    flushMs: storeMode === "v2" ? (storeOptions.flushMs ?? 500) : undefined,
    cacheTtlDays: cacheTtlDaysValue,
    baudMax: 5000000,
    bearerRequired: transport === "http" ? tokenRequired : undefined,
    anonymousAllowed: transport === "http" ? Boolean(http.anonymousAllowed) : undefined,
  };

  const endpoints =
    transport === "http"
      ? {
          mcp: {
            path: http.path,
            auth: tokenRequired ? "Bearer token" : "免鉴权",
            desc: "MCP Streamable HTTP（无状态，共享连接与日志）",
          },
          health: { path: http.healthPath, auth: "免鉴权", desc: "健康检查" },
          info: { path: http.infoPath, auth: "免鉴权", desc: "本页；加 ?format=html 得到可读版" },
          dumps: { path: "/dumps/{file_id}", auth: "Bearer token", desc: "下载 dump_to_file 产物" },
          ...(http.uiEnabled
            ? { ui: { path: "/", auth: "页面免鉴权；/api/* 需 Bearer", desc: "网页串口调试界面" } }
            : {}),
        }
      : undefined;

  const url = publicUrl || `http://${http.host || "<host>"}:${http.port || 8787}`;
  const integration =
    transport === "http"
      ? {
          hint: "把下面几段贴到客户端；token 从 SERIAL_HUB_MCP_HTTP_TOKEN 或 *_TOKEN_FILE 取，本页不显示。",
          snippets: [
            {
              title: "MCP 客户端（opencode / Claude Desktop 等）",
              code: JSON.stringify(
                {
                  mcp: {
                    "serial-hub": {
                      type: "remote",
                      url: `${url}/mcp`,
                      headers: { Authorization: "Bearer <token>" },
                      enabled: true,
                    },
                  },
                },
                null,
                2,
              ),
            },
            {
              title: "远端串口（可选）：remotes.json",
              code: JSON.stringify(
                {
                  remotes: [
                    {
                      name: "x86-hub",
                      endpoint: "tcp://<hub-host>:7000",
                      token_env: "SERIAL_HUB_TOKEN",
                    },
                  ],
                },
                null,
                2,
              ),
            },
            {
              title: "验证",
              code: [
                `curl -s ${url}/health`,
                `curl -s ${url}/info | head -c 400`,
                `open ${url}/info?format=html`,
              ].join("\n"),
            },
          ],
        }
      : {
          hint: "stdio 模式没有 HTTP 端点；客户端把本进程拉起即可使用工具。",
          snippets: [
            {
              title: "MCP 客户端（stdio）",
              code: JSON.stringify(
                {
                  mcp: {
                    "serial-hub": {
                      type: "stdio",
                      command: "node",
                      args: ["src/server.js"],
                      enabled: true,
                    },
                  },
                },
                null,
                2,
              ),
            },
          ],
        };

  return {
    service: "serial-hub-mcp",
    version,
    summary: SUMMARY,
    tools_count: toolsCount,
    deployment,
    storage,
    limits,
    ...(endpoints ? { endpoints } : {}),
    integration,
  };
}
