// 测试用最小 MCP 客户端：用官方 SDK 的 Client + StdioClientTransport 驱动本仓 server。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export class MCPClient {
  constructor(command, args = [], options = {}) {
    this.transport = new StdioClientTransport({
      command,
      args,
      env: options.env,
      stderr: options.stderr || "pipe",
      timeout: options.timeout || 30000,
    });
    this.client = new Client(
      { name: options.clientName || "serial-hub-mcp-smoke", version: "0.1.0" },
      { capabilities: {} },
    );
  }

  async start() {
    await this.client.connect(this.transport);
    return this.client;
  }

  async listTools() {
    const r = await this.client.listTools();
    return r.tools;
  }

  async callToolJson(name, args) {
    const r = await this.client.callTool({ name, arguments: args });
    return parseToolResult(r);
  }

  async close() {
    await this.client.close();
    await this.transport.close();
  }
}

export function parseToolResult(r) {
  const text = (r.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  return { isError: r.isError === true, data };
}