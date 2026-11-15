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
import { allocDumpFile, resolveDump } from "../src/dump_catalog.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
      assert.equal(tools.tools.length, 22);

      const r = await client.callTool({ name: "service_info", arguments: {} });
      const data = JSON.parse(r.content[0].text);
      assert.equal(data.ok, true);
      assert.equal(data.response.service, "serial-hub-mcp");
      assert.equal(data.response.tools_count, 22);

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

test("HTTP: GET /dumps/<file_id> 鉴权下载，拒绝穿越", { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dump-http-"));
  const prev = process.env.SERIAL_HUB_MCP_DUMPS_DIR;
  process.env.SERIAL_HUB_MCP_DUMPS_DIR = dir;
  const hub = makeHub();
  const token = "dump-token";
  const server = createHttpServer({
    createServer: hub.createServer,
    path: "/mcp",
    token,
    resolveDump,
  });
  const port = await listen(server);
  const { file_id, file } = allocDumpFile("dump");
  fs.writeFileSync(file, "wifi-dsp\n");
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/dumps/${file_id}`);
    assert.equal(denied.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/dumps/${file_id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "wifi-dsp\n");

    const traversal = await fetch(`http://127.0.0.1:${port}/dumps/..%2Fetc%2Fpasswd`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(traversal.status, 404);

    const missing = await fetch(`http://127.0.0.1:${port}/dumps/missing.log`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(missing.status, 404);
  } finally {
    await closeServer(server);
    await hub.manager.closeAll();
    if (prev === undefined) delete process.env.SERIAL_HUB_MCP_DUMPS_DIR;
    else process.env.SERIAL_HUB_MCP_DUMPS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
