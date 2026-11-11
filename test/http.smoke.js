import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer } from "../src/sdk/http.js";
import { buildServer } from "../src/sdk/server.js";
import { buildServiceInfo } from "../src/sdk/service-info.js";
import { ConnectionManager } from "../src/connection.js";
import { LogStore } from "../src/log_store.js";
import { LogRouter } from "../src/log_router.js";
import { keyedSerialQueue } from "../src/keyed_queue.js";
import { buildTools } from "../src/tools/index.js";

function makeHub() {
  const store = new LogStore({ dir: null });
  const router = new LogRouter(store);
  const manager = new ConnectionManager(router);
  const queue = keyedSerialQueue();
  const tools = buildTools(manager, router, { version: "test" });
  return {
    manager,
    tools,
    createServer: () => buildServer({ name: "serial-hub-mcp", version: "test", tools, queue }),
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

test(
  "HTTP: Bearer 鉴权 + tools/list + service_info + 免鉴权 /health",
  { timeout: 20000 },
  async () => {
    const hub = makeHub();
    const token = "test-token";
    const server = createHttpServer({
      createServer: hub.createServer,
      path: "/mcp",
      token,
      health: { ok: true, service: "serial-hub-mcp" },
      info: buildServiceInfo({
        service: "serial-hub-mcp",
        version: "test",
        extra: { tools_count: hub.tools.length },
      }),
    });
    const port = await listen(server);
    const mcpUrl = new URL(`http://127.0.0.1:${port}/mcp`);

    try {
      // 无 token → 拒绝
      const denied = new Client({ name: "denied", version: "0" }, { capabilities: {} });
      const deniedTransport = new StreamableHTTPClientTransport(mcpUrl);
      await assert.rejects(() => denied.connect(deniedTransport));

      // 带 token → 正常握手/枚举/调用
      const client = new Client({ name: "ok", version: "0" }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(mcpUrl, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      await client.connect(transport);
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 20);

      const r = await client.callTool({ name: "service_info", arguments: {} });
      const data = JSON.parse(r.content[0].text);
      assert.equal(data.ok, true);
      assert.equal(data.response.service, "serial-hub-mcp");
      assert.equal(data.response.tools_count, 20);

      // /health 免鉴权
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).ok, true);

      await client.close();
      await transport.close();
    } finally {
      await closeServer(server);
      await hub.manager.closeAll();
    }
  },
);
