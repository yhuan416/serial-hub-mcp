// list_ports：汇总所有已配置 remote 的端口列表。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HubServer } from "../src/hub-server/server.js";
import { connTools } from "../src/tools/conn.js";
import { ConnectionManager } from "../src/connection.js";
import { LogRouter } from "../src/log_router.js";
import { LogStore } from "../src/log_store.js";

function fakeSerialFactory() {
  return {
    isOpen: true,
    on() {},
    open(cb) {
      if (cb) cb();
    },
    write(_buf, cb) {
      if (cb) cb();
    },
    set(_opts, cb) {
      if (cb) cb();
    },
    update(_opts, cb) {
      if (cb) cb();
    },
    close(cb) {
      this.isOpen = false;
      if (cb) cb();
    },
  };
}

async function startHub(t, portPath, token) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shub-list-"));
  const srv = new HubServer({
    dataDir: dir,
    token,
    fwVersion: "test",
    listPorts: async () => [{ path: portPath, manufacturer: "ACME", serialNumber: "SN-1" }],
    serialFactory: fakeSerialFactory,
    scanIntervalMs: 600000,
  });
  const addr = await srv.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return addr.port;
}

function withEnv(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(patch)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

test("list_ports: 汇总多个 remote + 失败隔离", async (t) => {
  const portA = await startHub(t, "/dev/ttyFAKE0", "t0k");
  const portB = await startHub(t, "/dev/ttyFAKE1", "t0k");
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "shub-remotes-cfg-"));
  const cfgFile = path.join(cfgDir, "remotes.json");
  fs.writeFileSync(
    cfgFile,
    JSON.stringify({
      remotes: [
        { name: "alpha", endpoint: `tcp://127.0.0.1:${portA}`, token: "t0k" },
        { name: "beta", endpoint: `tcp://127.0.0.1:${portB}`, token: "t0k" },
        { name: "dead", endpoint: "tcp://127.0.0.1:1", token: "x", timeout_ms: 1500 },
      ],
    }),
  );

  await withEnv(
    { SERIAL_HUB_MCP_REMOTES: undefined, SERIAL_HUB_MCP_REMOTES_FILE: cfgFile },
    async () => {
      const tool = connTools({}).find((x) => x.name === "list_ports");
      const r = await tool.handler({ include_local: false });
      const res = r.response;
      assert.equal(res.sources.length, 3);
      const ok = res.sources.filter((s) => s.ok);
      const fail = res.sources.filter((s) => !s.ok);
      assert.equal(ok.length, 2);
      assert.equal(fail.length, 1);
      assert.match(fail[0].error, /ECONNREFUSED|连接|超时/);
      assert.deepEqual(res.ports.map((p) => p.id).sort(), ["ttyFAKE0", "ttyFAKE1"]);
      assert.ok(res.ports.every((p) => p.source === "remote" && p.remote && p.endpoint));
      assert.ok(Array.isArray(res.warnings) && res.warnings.length === 1);

      // 只查一个已配置 remote
      const one = await tool.handler({ remote: "alpha", include_local: false });
      assert.equal(one.response.ports.length, 1);
      assert.equal(one.response.ports[0].remote, "alpha");

      // 显式 endpoint：保留旧形状
      const legacy = await tool.handler({
        endpoint: `tcp://127.0.0.1:${portB}`,
        token: "t0k",
        include_local: false,
      });
      assert.equal(legacy.response.source, "remote");
      assert.equal(legacy.response.ports[0].id, "ttyFAKE1");
      assert.ok(legacy.response.caps);
    },
  );

  fs.rmSync(cfgDir, { recursive: true, force: true });
});

test("open: 用 remote 名字解析 endpoint/token", async (t) => {
  const port = await startHub(t, "/dev/ttyFAKE9", "t0k");
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "shub-remotes-open-"));
  const cfgFile = path.join(cfgDir, "remotes.json");
  fs.writeFileSync(
    cfgFile,
    JSON.stringify({
      remotes: [{ name: "alpha", endpoint: `tcp://127.0.0.1:${port}`, token: "t0k" }],
    }),
  );
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "shub-open-logs-"));
  const manager = new ConnectionManager(new LogRouter(new LogStore({ dir: logDir })));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  await withEnv(
    { SERIAL_HUB_MCP_REMOTES: undefined, SERIAL_HUB_MCP_REMOTES_FILE: cfgFile },
    async () => {
      const open = connTools(manager).find((x) => x.name === "open");
      const r = await open.handler({ remote: "alpha", port_id: "ttyFAKE9", baud_rate: 115200 });
      assert.ok(r.response.connection_id);
      const conn = manager.get(r.response.connection_id);
      assert.equal(conn.config.transport, "remote");
      assert.equal(conn.config.port_id, "ttyFAKE9");
      assert.match(conn.config.endpoint, new RegExp(`:${port}$`));
      await manager.close(r.response.connection_id);
    },
  );

  fs.rmSync(cfgDir, { recursive: true, force: true });
});
