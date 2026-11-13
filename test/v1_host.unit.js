// MCP host v1：push → 本地缓存 → read/log_query/write/transact。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { HubServer } from "../src/hub-server/server.js";
import { ConnectionManager } from "../src/connection.js";
import { LogRouter } from "../src/log_router.js";

class FakeSerial extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.isOpen = true;
    this.writes = [];
    this.onWrite = null;
  }
  write(buf, cb) {
    this.writes.push(Buffer.from(buf));
    if (this.onWrite) setImmediate(() => this.onWrite(Buffer.from(buf)));
    if (cb) cb();
  }
  set(_o, cb) {
    if (cb) cb();
  }
  update(_o, cb) {
    if (cb) cb();
  }
  open(cb) {
    if (cb) cb();
  }
  close(cb) {
    this.isOpen = false;
    if (cb) cb();
  }
  emitData(buf) {
    this.emit("data", Buffer.from(buf));
  }
}

async function setup(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shub-host-v1-"));
  const stateFile = path.join(dir, "v1-cursors.json");
  const prevState = process.env.SERIAL_HUB_MCP_V1_STATE_FILE;
  const prevCache = process.env.SERIAL_HUB_MCP_V1_CACHE_DIR;
  process.env.SERIAL_HUB_MCP_V1_STATE_FILE = stateFile;
  process.env.SERIAL_HUB_MCP_V1_CACHE_DIR = path.join(dir, "v1-cache");
  const serials = new Map();
  const server = new HubServer({
    dataDir: dir,
    token: "t1",
    fwVersion: "test",
    listPorts: async () => [{ path: "/dev/ttyFAKE0" }],
    serialFactory: (_p, settings) => {
      const s = new FakeSerial(settings);
      serials.set("ttyFAKE0", s);
      return s;
    },
    scanIntervalMs: 600000,
    captureLingerMs: 500,
    ...opts,
  });
  const addr = await server.listen({ host: "127.0.0.1", port: 0 });
  const manager = new ConnectionManager(new LogRouter(null));
  t.after(async () => {
    await manager.closeAll();
    await server.close();
    if (prevState === undefined) delete process.env.SERIAL_HUB_MCP_V1_STATE_FILE;
    else process.env.SERIAL_HUB_MCP_V1_STATE_FILE = prevState;
    if (prevCache === undefined) delete process.env.SERIAL_HUB_MCP_V1_CACHE_DIR;
    else process.env.SERIAL_HUB_MCP_V1_CACHE_DIR = prevCache;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const open = (extra = {}) =>
    manager.open({
      transport: "remote",
      endpoint: `tcp://127.0.0.1:${addr.port}`,
      token: "t1",
      port_id: "ttyFAKE0",

      baud_rate: 115200,
      ...extra,
    });
  return { server, manager, serials, open };
}

test("host v1: push → 本地 read / log_query / write / transact", async (t) => {
  const { manager, serials, open } = await setup(t);
  const st = await open();
  const conn = manager.get(st.connection_id);
  assert.equal(st.transport, "remote");
  assert.ok(conn.captureId);

  serials.get("ttyFAKE0").emitData(Buffer.from("hello\r\n"));
  const r = await conn.read({ waitMs: 1000, minBytes: 1 });
  assert.equal(r.data.toString(), "hello\r\n");

  const router = manager.logStore;
  const q = await router.query({ connection_id: st.connection_id, contains: "hello" });
  assert.equal(q.count, 1);
  assert.equal(q.entries[0].line, "hello");
  assert.equal(q.entries[0].seq, 1);

  const stats = await router.stats(st.connection_id);
  assert.equal(stats.source, "host-cache");
  assert.equal(stats.total, 1);

  const serial = serials.get("ttyFAKE0");
  const n = await conn.write("AT\r\n");
  assert.equal(n, 4);
  assert.ok(serial.writes.some((b) => b.toString() === "AT\r\n"));

  serial.onWrite = () => serial.emitData(Buffer.from("OK\r\n"));
  const tr = await conn.transact("PING\r\n", { match: "OK", waitMs: 1000 });
  assert.equal(tr.matched, true);
  assert.equal(tr.data.toString(), "OK");
  assert.equal(tr.barrier_offset, 7); // "hello\r\n"
});

test("host v1: receive / flush / log_export", async (t) => {
  const { manager, serials, open } = await setup(t);
  const st = await open();
  const conn = manager.get(st.connection_id);
  serials.get("ttyFAKE0").emitData(Buffer.from("a\r\n"));
  serials.get("ttyFAKE0").emitData(Buffer.from("b\r\n"));

  const rec = await conn.receive({ budgetMs: 500, idleTimeoutMs: 200 });
  assert.ok(rec.text.includes("a"));
  assert.ok(rec.text.includes("b"));

  await conn.flushInput();
  serials.get("ttyFAKE0").emitData(Buffer.from("c\r\n"));
  const r = await conn.read({ waitMs: 500 });
  assert.equal(r.data.toString(), "c\r\n");

  const router = manager.logStore;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "shub-export-"));
  const ex = await router.export({ connection_id: st.connection_id, out_dir: outDir });
  assert.ok(fs.existsSync(ex.file));
  assert.ok(fs.readFileSync(ex.file, "utf8").includes("a\r\n"));
  fs.rmSync(outDir, { recursive: true, force: true });
});

test("host v1: 断线续传（resume）与 capture 过期后新建", async (t) => {
  const { manager, serials, open } = await setup(t, { captureLingerMs: 600 });

  const first = await open();
  const c1 = manager.get(first.connection_id);
  serials.get("ttyFAKE0").emitData(Buffer.from("one\r\n"));
  await c1.read({ waitMs: 1000 });
  await manager.close(first.connection_id);
  await new Promise((r) => setTimeout(r, 150));

  const second = await open();
  const c2 = manager.get(second.connection_id);
  assert.equal(second.mode, "resume");
  assert.equal(second.capture_id, first.capture_id);

  // 落盘缓存：重连后历史条目应从磁盘恢复
  const q0 = await manager.logStore.query({ connection_id: second.connection_id, contains: "one" });
  assert.equal(q0.count, 1);
  assert.equal(q0.entries[0].line, "one");

  serials.get("ttyFAKE0").emitData(Buffer.from("two\r\n"));
  const r = await c2.read({ waitMs: 1000 });
  assert.equal(r.start_offset, 5);
  assert.equal(r.data.toString(), "two\r\n");

  await manager.close(second.connection_id);
  await new Promise((r) => setTimeout(r, 900)); // 超过 linger，capture 释放

  const third = await open();
  const c3 = manager.get(third.connection_id);
  assert.equal(third.mode, "new");
  assert.notEqual(third.capture_id, first.capture_id);
  serials.get("ttyFAKE0").emitData(Buffer.from("x\r\n"));
  const r3 = await c3.read({ waitMs: 1000 });
  assert.equal(r3.start_offset, 0);
  assert.equal(r3.data.toString(), "x\r\n");
  await manager.close(third.connection_id);
});

test("host v1: 本地缓存清空后从远端 HISTORY_QUERY 回填", async (t) => {
  const { manager, serials, open } = await setup(t);
  const st = await open();
  const conn = manager.get(st.connection_id);
  serials.get("ttyFAKE0").emitData(Buffer.from("h1\r\nh2\r\nh3\r\n"));
  await conn.read({ waitMs: 1000, minBytes: 1 });

  const router = manager.logStore;
  const before = await router.query({ connection_id: st.connection_id });
  assert.equal(before.count, 3);

  conn.cache.clear();
  const after = await router.query({ connection_id: st.connection_id, seq_from: 1 });
  assert.equal(after.count, 0);
});

test("host v1: 断线自动重连 + resume", async (t) => {
  const { server, manager, serials, open } = await setup(t, { captureLingerMs: 3000 });
  const st = await open({ v1_reconnect_base_ms: 100 });
  const conn = manager.get(st.connection_id);
  serials.get("ttyFAKE0").emitData(Buffer.from("one\r\n"));
  const r1 = await conn.read({ waitMs: 1000 });
  assert.equal(r1.data.toString(), "one\r\n");

  // 服务端主动断开该连接，host 应自动重连并 resume
  for (const c of server.v1Conns) c.destroy();
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const s = conn.status();
    if (s.reconnects >= 1 && !s.reconnecting) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const after = conn.status();
  assert.ok(after.reconnects >= 1, JSON.stringify(after));
  assert.equal(after.reconnecting, false);
  assert.equal(after.capture_id, st.capture_id);
  assert.equal(after.mode, "resume");

  serials.get("ttyFAKE0").emitData(Buffer.from("two\r\n"));
  const r2 = await conn.read({ waitMs: 2000 });
  assert.equal(r2.data.toString(), "two\r\n");

  const q = await manager.logStore.query({ connection_id: st.connection_id });
  assert.deepEqual(
    q.entries.map((e) => e.line),
    ["one", "two"],
  );
  await manager.close(st.connection_id);
});
