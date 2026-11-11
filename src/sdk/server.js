// MCP server 装配：基于官方 @modelcontextprotocol/sdk 的 McpServer。
//
// buildServer() -> 装配好工具集的 McpServer（无 IO）
// runStdio()    -> 挂到 stdio 传输并接管进程生命周期

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tool.js";

export { McpServer };

export function buildServer({ name, version, tools, queue }) {
  const server = new McpServer({ name, version }, { capabilities: { tools: {} } });
  registerTools(server, tools, { queue });
  return server;
}

export async function runStdio(server, { name, onShutdown } = {}) {
  const transport = new StdioServerTransport();
  process.stderr.write(`[${name}] MCP server 启动（stdio）\n`);
  await server.connect(transport);

  let shuttingDown = false;
  const cleanup = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.close();
    } catch (_) {
      /* 忽略关闭期错误 */
    }
    if (onShutdown) {
      try {
        await onShutdown();
      } catch (_) {
        /* 忽略 */
      }
    }
    process.exit(code);
  };
  process.on("SIGINT", () => void cleanup(0));
  process.on("SIGTERM", () => void cleanup(0));
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[${name}] uncaughtException: ${(err && err.stack) || err}\n`);
    void cleanup(1);
  });
  process.on("unhandledRejection", (err) => {
    process.stderr.write(`[${name}] unhandledRejection: ${(err && err.stack) || err}\n`);
  });

  transport.onclose = () => void cleanup(0);
  return transport;
}
