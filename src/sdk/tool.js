// 工具定义与注册：单一 schema 源 + 统一结果帧 + 可选按连接串行。
//
// 每个工具只在 defineTool() 描述里定义一次（name/title/description/inputSchema/handler），
// 由 registerTools() 挂到 McpServer；handler 的耗时统计、错误映射、队列都在此统一处理。

import { packResult, normalizeError } from "./result.js";

export function defineTool({ name, title, description, inputSchema, handler }) {
  if (!name || typeof handler !== "function") {
    throw new Error("defineTool: name 与 handler 必填");
  }
  return { name, title, description, inputSchema, handler };
}

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {object[]} tools
 * @param {{queue?:{run:(key:string|undefined, fn:Function)=>Promise}}} [opts]
 *   queue 按 args.connection_id 串行（同连接串行、跨连接放行）；缺省不排队。
 */
export function registerTools(server, tools, { queue } = {}) {
  let count = 0;
  for (const tool of tools) {
    if (!tool || !tool.name || typeof tool.handler !== "function") {
      throw new Error(`registerTools: 非法工具描述 ${tool && tool.name}`);
    }
    server.registerTool(
      tool.name,
      {
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      (args) => dispatch(tool, args, queue),
    );
    count += 1;
  }
  return count;
}

async function dispatch(tool, args, queue) {
  const started = Date.now();
  try {
    const run = () => tool.handler(args);
    const payload = queue ? await queue.run(args?.connection_id, run) : await run();
    return packResult({ ...(payload || {}), durationMs: Date.now() - started });
  } catch (err) {
    return packResult({ ...normalizeError(err), durationMs: Date.now() - started });
  }
}
