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

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildServer, runStdio } from "./sdk/server.js";
import { runHttp } from "./sdk/http.js";
import { buildServiceInfo } from "./sdk/service-info.js";
import { ConnectionManager } from "./connection.js";
import { LogStore } from "./log_store.js";
import { LogRouter } from "./log_router.js";
import { keyedSerialQueue } from "./keyed_queue.js";
import { buildTools } from "./tools/index.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const SERVICE = "serial-hub-mcp";
const CHANGELOG_PATH = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));

// 日志目录：env SERIAL_HUB_MCP_LOGS_DIR 可覆盖；缺省 $XDG_CACHE_HOME/serial-hub-mcp/logs。
// 内存保留条数：env SERIAL_HUB_MCP_LOG_MEM 可覆盖（默认 1000）。
// 磁盘保留上限：env SERIAL_HUB_MCP_LOG_RETAIN_BYTES 可覆盖（默认 64 MiB/连接，<=0 不淘汰仅内存）。
// 分片大小：env SERIAL_HUB_MCP_LOG_PART_BYTES 可覆盖（默认 8 MiB）。
const logStore = new LogStore({
  dir: process.env.SERIAL_HUB_MCP_LOGS_DIR ?? undefined,
  memEntries: Number(process.env.SERIAL_HUB_MCP_LOG_MEM) || undefined,
  retainBytes:
    process.env.SERIAL_HUB_MCP_LOG_RETAIN_BYTES !== undefined
      ? Number(process.env.SERIAL_HUB_MCP_LOG_RETAIN_BYTES)
      : undefined,
  partBytes: Number(process.env.SERIAL_HUB_MCP_LOG_PART_BYTES) || undefined,
});

// hub：本地连接用 LogStore；远端连接用 host 侧缓存。
const logRouter = new LogRouter(logStore);
const manager = new ConnectionManager(logRouter);
// 按连接串行：同连接排队，跨连接并发（hub 多设备必需）。
const queue = keyedSerialQueue();
const tools = buildTools(manager, logRouter, { version: pkg.version });

// 每个 HTTP 请求一个 server（无状态），但共享同一个 manager/router/queue。
const createServer = () => buildServer({ name: SERVICE, version: pkg.version, tools, queue });

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const httpMode = process.argv.includes("--http") || process.env.SERIAL_HUB_MCP_HTTP === "1";

if (httpMode) {
  const host = argValue("--host") || process.env.SERIAL_HUB_MCP_HTTP_HOST || "127.0.0.1";
  const port = Number(argValue("--port") || process.env.SERIAL_HUB_MCP_HTTP_PORT || 8787);
  const path = argValue("--path") || process.env.SERIAL_HUB_MCP_HTTP_PATH || "/mcp";
  const healthPath = process.env.SERIAL_HUB_MCP_HTTP_HEALTH_PATH || "/health";
  const infoPath = process.env.SERIAL_HUB_MCP_HTTP_INFO_PATH || "/info";
  const token = process.env.SERIAL_HUB_MCP_HTTP_TOKEN || undefined;

  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (!token && !loopback) {
    process.stderr.write(
      `[${SERVICE}] 警告：绑定非回环地址 ${host} 但未设置 SERIAL_HUB_MCP_HTTP_TOKEN，` +
        "任何能访问该端口的人都能操作串口\n",
    );
  }

  await runHttp({
    createServer,
    name: SERVICE,
    host,
    port,
    path,
    healthPath,
    infoPath,
    token,
    health: { ok: true, service: SERVICE, version: pkg.version, transport: "http" },
    info: buildServiceInfo({
      service: SERVICE,
      version: pkg.version,
      endpoints: { mcp: path, health: healthPath, info: infoPath },
      changelogPath: CHANGELOG_PATH,
      extra: { tools_count: tools.length },
    }),
    onShutdown: async () => {
      await manager.closeAll();
    },
  });
} else {
  await runStdio(createServer(), {
    name: SERVICE,
    onShutdown: async () => {
      await manager.closeAll();
    },
  });
}
