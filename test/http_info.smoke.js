// serial-hub-mcp 的 /info：与 service_info 同源，JSON/HTML 两种表示，免鉴权且不含 token。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHttpServer } from "../src/sdk/http.js";
import { buildServiceInfo } from "../src/sdk/service-info.js";
import { buildMcpInfo } from "../src/info.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function makeServer(ctx) {
  return createHttpServer({
    createServer: () => {
      throw new Error("MCP transport 不参与本测试");
    },
    path: "/mcp",
    token: "http-secret-token",
    info: (req) =>
      buildServiceInfo({
        service: "serial-hub-mcp",
        version: "1.2.3",
        dynamic: () => buildMcpInfo({ ...ctx, req }),
      }),
  });
}

test("MCP /info：JSON 自描述 + 免鉴权 + 不含 token", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-info-"));
  fs.writeFileSync(path.join(dir, "a.log"), Buffer.alloc(2048));
  const ctx = {
    version: "1.2.3",
    storeMode: "v2",
    paths: {
      localStore: dir,
      remoteStore: path.join(dir, "missing"),
      dumps: dir,
      sync: path.join(dir, "sync"),
      v1Cache: path.join(dir, "v1"),
      profiles: dir,
      opens: path.join(dir, "opens.json"),
    },
    storeOptions: { retainBytes: 512 * 1024 * 1024 },
    cacheTtlDaysValue: 7,
    toolsCount: 20,
    remotes: { count: 1, names: ["lab"] },
    startedAtMs: Date.now() - 65_000,
    http: {
      host: "127.0.0.1",
      port: 8787,
      path: "/mcp",
      healthPath: "/health",
      infoPath: "/info",
      uiEnabled: true,
      tokenRequired: true,
      anonymousAllowed: false,
    },
  };
  const server = makeServer(ctx);
  const port = await listen(server);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const res = await fetch(`http://127.0.0.1:${port}/info`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.match(res.headers.get("vary") || "", /Accept/);
  const info = await res.json();
  assert.equal(info.service, "serial-hub-mcp");
  assert.equal(info.version, "1.2.3");
  assert.equal(info.tools_count, 20);
  assert.equal(info.deployment.transport, "http");
  assert.equal(info.deployment.uptimeSeconds >= 60, true);
  assert.equal(info.deployment.publicUrl, `http://127.0.0.1:${port}`);
  assert.equal(info.deployment.auth.includes("Bearer"), true);
  assert.equal(info.storage.mode, "v2");
  assert.ok(info.storage.localStoreSize.includes("2.0 KiB"));
  assert.equal(info.limits.tools, 20);
  assert.equal(info.limits.remotes, 1);
  assert.equal(info.endpoints.mcp.path, "/mcp");
  assert.ok(info.integration.snippets.some((s) => s.code.includes("/mcp")));
  assert.equal(JSON.stringify(info).includes("http-secret-token"), false);
});

test("MCP /info：?format=html / Accept 返回可读页", async (t) => {
  const ctx = {
    version: "1.2.3",
    storeMode: "legacy",
    paths: {
      logs: "/tmp/none",
      dumps: "/tmp/none",
      sync: "/tmp/none",
      v1Cache: "/tmp/none",
      profiles: "/tmp/none",
      opens: "/tmp/opens.json",
    },
    http: {
      host: "127.0.0.1",
      port: 8787,
      path: "/mcp",
      healthPath: "/health",
      infoPath: "/info",
      uiEnabled: false,
      tokenRequired: false,
    },
  };
  const server = makeServer(ctx);
  const port = await listen(server);
  t.after(() => new Promise((r) => server.close(r)));

  const html = await fetch(`http://127.0.0.1:${port}/info?format=html`);
  assert.match(html.headers.get("content-type"), /text\/html/);
  const body = await html.text();
  for (const section of ["部署", "存储", "限制", "端点", "接入步骤"]) {
    assert.ok(body.includes(section), `缺少段落 ${section}`);
  }
  assert.ok(body.includes("存储模式"));
  assert.ok(body.includes("日志"));

  const byAccept = await fetch(`http://127.0.0.1:${port}/info`, {
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  assert.match(byAccept.headers.get("content-type"), /text\/html/);
});

test("MCP /info：SERIAL_HUB_MCP_PUBLIC_URL 优先于 Host", async (t) => {
  const prev = process.env.SERIAL_HUB_MCP_PUBLIC_URL;
  process.env.SERIAL_HUB_MCP_PUBLIC_URL = "https://mcp.example.com/";
  t.after(() => {
    if (prev === undefined) delete process.env.SERIAL_HUB_MCP_PUBLIC_URL;
    else process.env.SERIAL_HUB_MCP_PUBLIC_URL = prev;
  });
  const ctx = {
    version: "1.2.3",
    storeMode: "v2",
    paths: {},
    http: {
      host: "0.0.0.0",
      port: 8788,
      path: "/mcp",
      healthPath: "/health",
      infoPath: "/info",
      uiEnabled: true,
      tokenRequired: true,
    },
  };
  const server = makeServer(ctx);
  const port = await listen(server);
  t.after(() => new Promise((r) => server.close(r)));

  const info = await (await fetch(`http://127.0.0.1:${port}/info`)).json();
  assert.equal(info.deployment.publicUrl, "https://mcp.example.com");
  assert.ok(info.integration.snippets.some((s) => s.code.includes("https://mcp.example.com/mcp")));
});
