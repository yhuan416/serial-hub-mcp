import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostLogStore } from "../src/host_log_store.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "serial_hub_store-"));
}

async function withStore(opts, fn) {
  const dir = tmpDir();
  const store = new HostLogStore({ dir, flushMs: 60_000, ...opts });
  try {
    return await fn(store, dir);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("HostLogStore: 行切分 / 残行 / TX / 查询", async () => {
  await withStore({}, async (s) => {
    s.addData("c1", Buffer.from("AT\r\nOK\r\nERR"));
    s.addTx("c1", Buffer.from("PING"));
    const q = await s.query({ connection_id: "c1", limit: 10 });
    assert.equal(q.entries.map((e) => e.line).join(","), "AT,OK,PING");
    assert.equal(q.entries[0].dir, "rx");
    assert.equal(q.entries[2].dir, "tx");
    assert.equal(q.current_partial.text, "ERR");
    const rx = await s.query({ connection_id: "c1", dir: "rx" });
    assert.equal(rx.count, 2);
    const byContains = await s.query({ connection_id: "c1", contains: "OK" });
    assert.equal(byContains.count, 1);
    const byRegex = await s.query({ connection_id: "c1", regex: "^AT" });
    assert.equal(byRegex.count, 1);
    const desc = await s.query({ connection_id: "c1", order: "desc", limit: 2 });
    assert.deepEqual(
      desc.entries.map((e) => e.line),
      ["PING", "OK"],
    );
  });
});

test("HostLogStore: 跨 chunk 残行累积", async () => {
  await withStore({}, async (s) => {
    s.addData("c2", Buffer.from("HEL"));
    s.addData("c2", Buffer.from("LO\nWORL"));
    s.addData("c2", Buffer.from("D\nEND"));
    const q = await s.query({ connection_id: "c2" });
    assert.equal(q.entries.map((e) => e.line).join(","), "HELLO,WORLD");
    assert.equal(q.current_partial.text, "END");
  });
});

test("HostLogStore: 无换行流不会无限攒 partial", async () => {
  await withStore({ maxPartialBytes: 1024 }, async (s) => {
    s.addData("c3", Buffer.alloc(5000, 0x41));
    const q = await s.query({ connection_id: "c3" });
    assert.ok(q.total >= 1);
    assert.equal(s.currentPartial("c3"), null);
  });
});

test("HostLogStore: unregister 落残行；clear", async () => {
  await withStore({}, async (s) => {
    s.addData("c4", Buffer.from("START\nPARTIAL"));
    s.unregister("c4");
    let q = await s.query({ connection_id: "c4" });
    assert.equal(q.entries.map((e) => e.line).join(","), "START,PARTIAL");
    s.addData("c4", Buffer.from("again\n"));
    q = await s.query({ connection_id: "c4" });
    assert.ok(q.total >= 3);
    s.clear("c4");
    q = await s.query({ connection_id: "c4" });
    assert.equal(q.total, 0);
    assert.equal(q.count, 0);
  });
});

test("HostLogStore: 跨连接 seq 全局升序", async () => {
  await withStore({ segmentBytes: 512, blockBytes: 256 }, async (s) => {
    s.addData("cA", Buffer.from("a1\na2\na3\n"));
    s.addData("cB", Buffer.from("b1\nb2\nb3\n"));
    s.addData("cA", Buffer.from("a4\na5\na6\n"));
    const q = await s.query({ order: "asc", limit: 30 });
    const seqs = q.entries.map((e) => e.seq);
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
    );
    assert.equal(q.total, 9);
  });
});

test("HostLogStore: 段轮转与保留淘汰", async () => {
  await withStore(
    { segmentBytes: 256, blockBytes: 128, retainBytes: 300, retainDays: 7 },
    async (s) => {
      for (let i = 0; i < 50; i += 1) {
        s.addData("c5", Buffer.from(`L${String(i).padStart(2, "0")}\n`));
      }
      const q = await s.query({ connection_id: "c5", limit: 100 });
      assert.ok(q.total < 50, `total=${q.total}`);
      assert.ok(q.retention.disk_partitions >= 1);
      assert.ok(q.retention.evicted_lines > 0, `evicted=${q.retention.evicted_lines}`);
      const st = s.stats("c5");
      assert.ok(st.connections[0].partitions >= 1);
      assert.ok(st.connections[0].evicted_lines > 0);
    },
  );
});

test("HostLogStore: 崩溃/尾段截断恢复", async () => {
  const dir = tmpDir();
  const s = new HostLogStore({
    dir,
    segmentBytes: 4096,
    blockBytes: 512,
    flushMs: 60_000,
  });
  try {
    for (let i = 0; i < 20; i += 1) s.addData("c6", Buffer.from(`R${i}\n`));
    s._flushAll();
    clearInterval(s._timer);
    clearInterval(s._retainTimer);
    s.db.close();
    const seg = path.join(
      dir,
      "c6",
      fs.readdirSync(path.join(dir, "c6")).find((f) => f.endsWith(".shl")),
    );
    const size = fs.statSync(seg).size;
    fs.truncateSync(seg, size - 8);
    const s2 = new HostLogStore({ dir, segmentBytes: 4096, blockBytes: 512, flushMs: 60_000 });
    try {
      const q = await s2.query({ connection_id: "c6", limit: 100 });
      assert.ok(q.total > 0 && q.total <= 20);
      assert.ok(q.entries.every((e) => /^R\d+$/.test(e.line)));
    } finally {
      s2.close();
    }
  } finally {
    try {
      s.close();
    } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HostLogStore: 时间/seq 过滤与 stats", async () => {
  await withStore({}, async (s) => {
    s.addData("c7", Buffer.from("T0\nT1\nT2\nT3\n"));
    const all = (await s.query({ connection_id: "c7", limit: 10 })).entries;
    const mid = all[2];
    const before = await s.query({ connection_id: "c7", time_to: mid.ts - 1, limit: 10 });
    const after = await s.query({ connection_id: "c7", time_from: mid.ts + 1, limit: 10 });
    assert.ok(before.count + after.count <= all.length);
    const bySeq = await s.query({ connection_id: "c7", seq_from: mid.seq, seq_to: mid.seq });
    assert.equal(bySeq.count, 1);
    const st = s.stats("c7");
    assert.equal(st.connections[0].total, 4);
    assert.ok(st.connections[0].time_range);
  });
});

test("HostLogStore + Connection: 本地收发、残行、dump", async () => {
  const { EventEmitter } = await import("node:events");
  const { Connection } = await import("../src/connection.js");
  const dir = tmpDir();
  const store = new HostLogStore({ dir, flushMs: 60_000 });
  const port = new EventEmitter();
  port.path = "/dev/fake-store";
  port.open = (cb) => cb();
  port.close = (cb) => cb();
  port.write = (b, cb) => cb(null);
  port.drain = (cb) => cb();
  port.flush = (cb) => cb();
  port.set = (opts, cb) => cb();
  const conn = new Connection(null, port, { rx_buffer_size: 1024 }, store);
  try {
    conn._onData(Buffer.from("AT\r\nOK\r\nTAIL"));
    await conn.write(Buffer.from("PING"));
    const q = await store.query({ connection_id: conn.id, limit: 10 });
    assert.equal(q.entries.map((e) => e.line).join(","), "AT,OK,PING");
    assert.equal(conn.status().current_partial_line.text, "TAIL");
    const file = path.join(dir, "dump.log");
    const r = await conn.dumpToFile({ file, seq_from: 1, seq_to: 2 });
    assert.equal(r.lines, 2);
    assert.match(fs.readFileSync(file, "utf8"), /AT/);
    await conn.close();
    const after = await store.query({ connection_id: conn.id, limit: 10 });
    assert.ok(after.entries.some((e) => e.line === "TAIL"));
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
