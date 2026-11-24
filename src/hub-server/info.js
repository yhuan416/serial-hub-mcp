// serial-hub-server 的 /info 数据：部署 / 存储 / 限制 / 端点 / 接入步骤。
//
// 与 MCP 侧同一套页面骨架（src/sdk/info-page.js），但服务形态不同：
// 这里的主端点是一个二进制 TCP 服务（SH 帧），HTTP 只用于自描述和健康检查。
// 页面免鉴权，因此不读 token、不展示 token 来源的具体值。

import path from "node:path";
import { dirStats, formatBytes, resolvePublicUrl } from "../sdk/info-page.js";

const SUMMARY = "x86 远端串口服务：把本机串口通过二进制帧（SH）暴露给 serial-hub-mcp。";
const WILDCARD = new Set(["0.0.0.0", "::", ""]);

/** token 只报“从哪来”，不报具体路径（页面免鉴权）。 */
function tokenSourceLabel(src) {
  if (!src) return undefined;
  if (src === "--token") return "命令行 --token";
  if (src === "SERIAL_HUB_SERVER_TOKEN") return "环境变量 SERIAL_HUB_SERVER_TOKEN";
  if (String(src).startsWith("SERIAL_HUB_SERVER_TOKEN_FILE")) {
    return "环境变量 SERIAL_HUB_SERVER_TOKEN_FILE";
  }
  return "data-dir/token 文件";
}

function listenOf(server) {
  let addr = null;
  try {
    addr = server.server.address();
  } catch (_) {
    /* 未监听 */
  }
  if (addr && typeof addr === "object") return { host: addr.address, port: addr.port };
  return { host: null, port: null };
}

/** 数据目录下每个端口一个子目录；汇总直接子文件的体积。 */
function dataDirStats(dataDir, portIds) {
  const dirs = [dataDir, ...portIds.map((id) => (dataDir ? path.join(dataDir, id) : null))];
  let files = 0;
  let sizeBytes = 0;
  let found = false;
  for (const dir of dirs) {
    const st = dirStats(dir);
    if (!st) continue;
    found = true;
    files += st.files;
    sizeBytes += st.sizeBytes;
  }
  if (!found) return "尚未创建";
  return `${files} 个文件 · ${formatBytes(sizeBytes)}`;
}

/**
 * @param {import("./server.js").HubServer} server
 * @param {{version?: string, req?: {headers?: object}, env?: object}} [opts]
 */
export function buildHubInfo(server, opts = {}) {
  const { version = server.fwVersion || "unknown", req, env = process.env } = opts;
  const { host, port } = listenOf(server);
  const manager = server.manager;
  const ports = manager.list();
  const portIds = ports.map((p) => p.id);
  const wildcard = !host || WILDCARD.has(String(host));
  const fallback = wildcard ? null : `http://${host}:${port}`;
  const publicUrl = resolvePublicUrl({
    envUrl: env.SERIAL_HUB_SERVER_PUBLIC_URL,
    req,
    fallback,
  });
  const uptimeSeconds = Math.max(
    0,
    Math.round((Date.now() - (server.startedAt || Date.now())) / 1000),
  );
  const filter = (manager.portFilter || []).join(", ");

  const deployment = {
    runtime: `node ${process.version}`,
    platform: `${process.platform} ${process.arch}`,
    transport: "tcp（二进制 SH 帧）+ HTTP 自描述",
  };
  if (publicUrl) deployment.publicUrl = publicUrl;
  if (host) deployment.listen = `${host}:${port}`;
  deployment.startedAt = new Date(server.startedAt || Date.now()).toISOString();
  deployment.uptimeSeconds = uptimeSeconds;
  deployment.bootId = server.bootId;
  deployment.ports = ports.length;
  deployment.portIds = portIds.length ? portIds.join("、") : "（无）";
  if (server.tokenSource) deployment.tokenSource = tokenSourceLabel(server.tokenSource);
  if (env.SERIAL_HUB_IMAGE) deployment.image = env.SERIAL_HUB_IMAGE;

  const storage = {
    dataDir: server.dataDir,
    dataDirSize: dataDirStats(server.dataDir, portIds),
    retentionBytes: formatBytes(manager.retentionBytes),
    retentionDays: manager.retentionDays,
    segmentBytes: formatBytes(manager.segmentBytes),
  };

  const limits = {
    ports: ports.length,
    portFilter: filter || '全部（--ports ""）',
    ringBytes: formatBytes(manager.ringBytes),
    ramEntries: manager.ramEntries,
    maxFrame: formatBytes(server.maxFrame),
    maxHoldMs: server.manager.maxHoldMs,
    scanIntervalMs: server.scanIntervalMs,
    captureMaxBytes: formatBytes(server.captureMaxBytes),
    captureLingerMs: server.captureLingerMs,
    windowBytes: formatBytes(server.v1WindowBytes),
    maxWindowBytes: formatBytes(server.v1MaxWindowBytes),
    leaseMs: server.v1LeaseMs,
    baudMax: ports.reduce((max, p) => Math.max(max, p.caps?.baud_max || 0), 0) || 5000000,
    bearerRequired: Boolean(server.token),
  };

  const endpoints = {
    tcp: {
      path: `${host || "<host>"}:${port}`,
      auth: server.token ? "HELLO token" : "无 token",
      desc: "二进制帧（魔数 SH），MCP 的 remote 传输",
    },
    info: { path: "/info", auth: "免鉴权", desc: "本页；加 ?format=html 得到可读版" },
    health: { path: "/health", auth: "免鉴权", desc: "健康检查（HTTP，与 7000 同端口）" },
  };

  const url = publicUrl || `http://${host && !wildcard ? host : "<host>"}:${port || 7000}`;
  const tcpUrl = `tcp://${host && !wildcard ? host : "<host>"}:${port || 7000}`;
  const exampleId = portIds[0] || "<port_id>";
  const integration = {
    hint: "先把这个 hub 注册到 MCP 的 remotes.json，再用 serial-hub_open 选端口；token 从 <data-dir>/token 或 SERIAL_HUB_SERVER_TOKEN 取，本页不显示。",
    snippets: [
      {
        title: "remotes.json（MCP 侧）",
        code: JSON.stringify(
          {
            remotes: [
              {
                name: "x86-hub",
                endpoint: tcpUrl,
                token_env: "SERIAL_HUB_TOKEN",
              },
            ],
          },
          null,
          2,
        ),
      },
      {
        title: `打开串口（serial-hub_open，port_id 见上）`,
        code: JSON.stringify(
          {
            transport: "remote",
            remote: "x86-hub",
            port_id: exampleId,
            baud_rate: 115200,
          },
          null,
          2,
        ),
      },
      {
        title: "验证",
        code: [`curl -s ${url}/health`, `curl -s ${url}/info | head -c 400`].join("\n"),
      },
    ],
  };

  return {
    service: "serial-hub-server",
    version,
    summary: SUMMARY,
    deployment,
    storage,
    limits,
    endpoints,
    integration,
    // 详情只给选路必需的字段；序列号等设备标识不放在免鉴权页面上。
    ports: ports.map((p) => ({
      id: p.id,
      path: p.path,
      open: p.open,
      baud_rate: p.baud_rate,
      vendor_id: p.vendor_id,
      product_id: p.product_id,
      manufacturer: p.manufacturer,
    })),
  };
}
