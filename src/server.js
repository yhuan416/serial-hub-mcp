#!/usr/bin/env node
// serial-hub-mcp — serial port MCP server / hub.
//
// 传输：
//   stdio（默认）：node src/server.js
//   HTTP        ：node src/server.js --http   （Streamable HTTP，默认 127.0.0.1:8787/mcp）
//
// HTTP 相关环境变量：
//   SERIAL_HUB_MCP_HTTP=1            启用 HTTP（等价 --http）
//   SERIAL_HUB_MCP_HTTP_HOST         默认 127.0.0.1
//   SERIAL_HUB_MCP_HTTP_PORT         默认 8787
//   SERIAL_HUB_MCP_HTTP_PATH         默认 /mcp
//   SERIAL_HUB_MCP_HTTP_HEALTH_PATH  默认 /health
//   SERIAL_HUB_MCP_HTTP_INFO_PATH    默认 /info
//   SERIAL_HUB_MCP_HTTP_TOKEN        可选 Bearer token（绑定非回环地址时强烈建议设置）
//   SERIAL_HUB_MCP_HTTP_UI           默认 1；设为 0 关闭自带的网页调试界面（GET /）

import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildServer, runStdio } from "./sdk/server.js";
import { runHttp } from "./sdk/http.js";
import { buildServiceInfo } from "./sdk/service-info.js";
import { createWebApi } from "./web_api.js";
import { ConnectionManager } from "./connection.js";
import { LogStore } from "./log_store.js";
import { HostLogStore } from "./host_log_store.js";
import { LogRouter } from "./log_router.js";
import { keyedSerialQueue } from "./keyed_queue.js";
import { buildTools } from "./tools/index.js";
import { resolveDump } from "./dump_catalog.js";
import { cacheTtlDays, startCacheSweep } from "./cache_ttl.js";
import { readSecret } from "./secrets.js";
import { buildHttpAllowlist } from "./http_allowlist.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const SERVICE = "serial-hub-mcp";
const CHANGELOG_PATH = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const httpMode = process.argv.includes("--http") || process.env.SERIAL_HUB_MCP_HTTP === "1";
const httpHost = argValue("--host") || process.env.SERIAL_HUB_MCP_HTTP_HOST || "127.0.0.1";
const httpPort = Number(argValue("--port") || process.env.SERIAL_HUB_MCP_HTTP_PORT || 8787);
const httpPath = argValue("--path") || process.env.SERIAL_HUB_MCP_HTTP_PATH || "/mcp";
const httpHealthPath = process.env.SERIAL_HUB_MCP_HTTP_HEALTH_PATH || "/health";
const httpInfoPath = process.env.SERIAL_HUB_MCP_HTTP_INFO_PATH || "/info";
const httpUiEnabled = process.env.SERIAL_HUB_MCP_HTTP_UI !== "0";
const httpAllowAnonymous =
  process.argv.includes("--allow-anonymous") ||
  process.env.SERIAL_HUB_MCP_HTTP_ALLOW_ANONYMOUS === "1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const httpBindIsLoopback = LOOPBACK_HOSTS.has(httpHost);
const { allowedHosts: httpAllowedHosts, allowedOrigins: httpAllowedOrigins } = buildHttpAllowlist({
  host: httpHost,
  port: httpPort,
});

let httpToken;
if (httpMode) {
  try {
    httpToken = readSecret("SERIAL_HUB_MCP_HTTP_TOKEN");
  } catch (err) {
    process.stderr.write(`[${SERVICE}] 无法读取 HTTP token：${err.message}\n`);
    process.exit(1);
  }
}

// 非回环地址 + 无 token 默认拒绝启动，避免“能连上端口就能操作串口”。
if (httpMode && !httpToken && !httpBindIsLoopback) {
  if (!httpAllowAnonymous) {
    process.stderr.write(
      `[${SERVICE}] 拒绝启动：绑定非回环地址 ${httpHost} 但未设置 SERIAL_HUB_MCP_HTTP_TOKEN。` +
        "请设置 token，或显式加 --allow-anonymous / " +
        "SERIAL_HUB_MCP_HTTP_ALLOW_ANONYMOUS=1 确认允许匿名访问。\n",
    );
    process.exit(1);
  }
  process.stderr.write(
    `[${SERVICE}] 警告：已允许匿名访问 ${httpHost}:${httpPort}，` +
      "任何能访问该端口的人都能操作串口\n",
  );
}

// host 侧持久缓存：
//   SERIAL_HUB_MCP_STORE=v2|legacy  （默认 v2：二进制段 + SQLite 索引）
//   v2: SERIAL_HUB_MCP_STORE_DIR / _RETAIN_BYTES / _SEGMENT_BYTES / _BLOCK_BYTES / _FLUSH_MS
//   legacy: 旧的 SERIAL_HUB_MCP_LOGS_DIR / LOG_MEM / LOG_RETAIN_BYTES / LOG_PART_BYTES
const storeMode = process.env.SERIAL_HUB_MCP_STORE === "legacy" ? "legacy" : "v2";
const storeRetainBytes =
  process.env.SERIAL_HUB_MCP_STORE_RETAIN_BYTES !== undefined
    ? Number(process.env.SERIAL_HUB_MCP_STORE_RETAIN_BYTES)
    : process.env.SERIAL_HUB_MCP_LOG_RETAIN_BYTES !== undefined
      ? Number(process.env.SERIAL_HUB_MCP_LOG_RETAIN_BYTES)
      : undefined;
const storeOptions = {
  retainBytes: storeRetainBytes,
  retainDays: cacheTtlDays(),
  segmentBytes: Number(process.env.SERIAL_HUB_MCP_STORE_SEGMENT_BYTES) || undefined,
  blockBytes: Number(process.env.SERIAL_HUB_MCP_STORE_BLOCK_BYTES) || undefined,
  flushMs: Number(process.env.SERIAL_HUB_MCP_STORE_FLUSH_MS) || undefined,
};
const storeBase = path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
  "serial-hub-mcp",
  "store",
);
const localStoreDir = process.env.SERIAL_HUB_MCP_STORE_DIR || path.join(storeBase, "local");
const remoteStoreDir =
  process.env.SERIAL_HUB_MCP_REMOTE_STORE_DIR || path.join(storeBase, "remote");
const logStore =
  storeMode === "legacy"
    ? new LogStore({
        dir: process.env.SERIAL_HUB_MCP_LOGS_DIR ?? undefined,
        memEntries: Number(process.env.SERIAL_HUB_MCP_LOG_MEM) || undefined,
        retainBytes:
          process.env.SERIAL_HUB_MCP_LOG_RETAIN_BYTES !== undefined
            ? Number(process.env.SERIAL_HUB_MCP_LOG_RETAIN_BYTES)
            : undefined,
        partBytes: Number(process.env.SERIAL_HUB_MCP_LOG_PART_BYTES) || undefined,
        retainDays: cacheTtlDays(),
      })
    : new HostLogStore({ dir: localStoreDir, ...storeOptions });
const remoteStore =
  storeMode === "v2" ? new HostLogStore({ dir: remoteStoreDir, ...storeOptions }) : null;
const cacheSweep = startCacheSweep();

// hub：本地连接和远端 v1 的 host 缓存分两个目录，LogRouter 全量查询才不会被重复计入。
const logRouter = new LogRouter(logStore, { remoteStore });
const manager = new ConnectionManager(logRouter, { remoteStore });
// 按连接串行：同连接排队，跨连接并发（hub 多设备必需）。
const queue = keyedSerialQueue();
const tools = buildTools(manager, logRouter, { version: pkg.version });

// 每个 HTTP 请求一个 server（无状态），但共享同一个 manager/router/queue。
const createServer = () => buildServer({ name: SERVICE, version: pkg.version, tools, queue });

if (httpMode) {
  await runHttp({
    createServer,
    name: SERVICE,
    host: httpHost,
    port: httpPort,
    path: httpPath,
    healthPath: httpHealthPath,
    infoPath: httpInfoPath,
    token: httpToken,
    ...(httpAllowedHosts ? { allowedHosts: httpAllowedHosts } : {}),
    ...(httpAllowedOrigins ? { allowedOrigins: httpAllowedOrigins } : {}),
    webDir: httpUiEnabled ? fileURLToPath(new URL("./web/", import.meta.url)) : undefined,
    apiHandler: httpUiEnabled ? createWebApi({ manager, tools, queue }) : undefined,
    health: { ok: true, service: SERVICE, version: pkg.version, transport: "http" },
    info: buildServiceInfo({
      service: SERVICE,
      version: pkg.version,
      endpoints: {
        mcp: httpPath,
        health: httpHealthPath,
        info: httpInfoPath,
        dumps: "/dumps/{file_id}",
        ...(httpUiEnabled ? { ui: "/" } : {}),
      },
      changelogPath: CHANGELOG_PATH,
      extra: { tools_count: tools.length },
    }),
    resolveDump,
    onShutdown: async () => {
      cacheSweep.stop();
      await manager.closeAll();
      remoteStore?.close();
      logStore.close?.();
    },
  });
} else {
  await runStdio(createServer(), {
    name: SERVICE,
    onShutdown: async () => {
      cacheSweep.stop();
      await manager.closeAll();
      remoteStore?.close();
      logStore.close?.();
    },
  });
}
