#!/usr/bin/env node
// serial-hub-mcp — serial port MCP server / hub.
// 运行：node src/server.js（stdio 传输，供 opencode / Claude Desktop / MCP Inspector 直接连）

import { createRequire } from "node:module";
import { buildServer, runStdio } from "./sdk/server.js";
import { ConnectionManager } from "./connection.js";
import { LogStore } from "./log_store.js";
import { LogRouter } from "./log_router.js";
import { keyedSerialQueue } from "./keyed_queue.js";
import { buildTools } from "./tools/index.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

// 日志目录：env SERIAL_HUB_MCP_LOGS_DIR 可覆盖；缺省 ~/.cache/serial-hub-mcp/logs。
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

// hub：本地连接沿用 LogStore；远端连接后续绑定设备权威后端（RemoteLogStore）。
const logRouter = new LogRouter(logStore);
const manager = new ConnectionManager(logRouter);
// 按连接串行：同连接排队，跨连接并发（hub 多设备必需）。
const queue = keyedSerialQueue();
const tools = buildTools(manager, logRouter, { version: pkg.version });
const server = buildServer({
  name: "serial-hub-mcp",
  version: pkg.version,
  tools,
  queue,
});

await runStdio(server, {
  name: "serial-hub-mcp",
  onShutdown: async () => {
    await manager.closeAll();
  },
});
