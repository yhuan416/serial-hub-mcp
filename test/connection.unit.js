import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import { Connection } from "../src/connection.js";
import { LogStore } from "../src/log_store.js";

function fakePort() {
  const p = new EventEmitter();
  p.path = "/dev/fake0";
  p.open = (cb) => cb();
  p.close = (cb) => cb();
  p.write = (b, cb) => cb(null);
  p.drain = (cb) => cb();
  p.flush = (cb) => cb();
  p._lines = {};
  p._lineLog = [];
  p.set = (opts, cb) => {
    Object.assign(p._lines, opts);
    p._lineLog.push({ ...opts });
    cb();
  };
  return p;
}

test("跨 chunk 匹配与消费", async () => {
  const conn = new Connection(null, fakePort(), { rx_buffer_size: 100 });
  for (const s of ["XX", "A", "BC!!"]) conn._onData(Buffer.from(s));
  const idx = conn._indexOf(Buffer.from("AB"), 0);
  assert.equal(idx, 2);
  const r = await conn.read({ match: Buffer.from("AB"), waitMs: 0 });
  assert.equal(r.data.toString(), "XXAB");
  assert.equal(r.end_offset, 4);
});

test("裁剪：超 cap 丢最旧、游标回退", async () => {
  const conn = new Connection(null, fakePort(), { rx_buffer_size: 4 });
  conn._onData(Buffer.from("abcdef"));
  assert.equal(conn._length, 4);
  const r = await conn.read({ waitMs: 0 });
  assert.equal(r.data.toString(), "cdef");
});

test("transact 忽略写前噪声", async () => {
  const conn = new Connection(null, fakePort(), { rx_buffer_size: 100 });
  conn._onData(Buffer.from("NOISE"));
  const t = await conn.transact(Buffer.from("AT"), { match: Buffer.from("OK"), waitMs: 300 });
  assert.equal(t.data.length, 0);
  assert.equal(t.timed_out, true);
});

test("flushInput 清空缓冲", async () => {
  const conn = new Connection(null, fakePort(), { rx_buffer_size: 100 });
  conn._onData(Buffer.from("abc"));
  await conn.flushInput();
  assert.equal(conn._length, 0);
  assert.equal(conn.handled, 0);
});

test("裁剪后 handled 不越界", async () => {
  const conn = new Connection(null, fakePort(), { rx_buffer_size: 4 });
  await conn.read({ waitMs: 0 });
  conn._onData(Buffer.from("12345678"));
  assert.ok(conn.handled <= conn._length);
});

test("setLine 只设提供线", async () => {
  const port = fakePort();
  const conn = new Connection(null, port, { rx_buffer_size: 100 });
  await conn.setLine({ dtr: false });
  assert.equal(port._lines.dtr, false);
  assert.equal(port._lines.rts, undefined);
  assert.equal(conn.status().dtr, false);
  assert.equal(conn.status().rts, null);
  await conn.setLine({ rts: true });
  assert.equal(port._lines.dtr, false);
});

test("setPulse 设后保持再反转", async () => {
  const port = fakePort();
  const conn = new Connection(null, port, { rx_buffer_size: 100 });
  const t0 = Date.now();
  const level = await conn.setPulse({ dtr: false, pulseMs: 30 });
  const elapsed = Date.now() - t0;
  assert.equal(level.dtr, true);
  assert.equal(port._lineLog.length, 2);
  assert.equal(port._lineLog[0].dtr, false);
  assert.equal(port._lineLog[1].dtr, true);
  assert.ok(elapsed >= 30);
});

test("sendBreak brk true→false", async () => {
  const port = fakePort();
  const conn = new Connection(null, port, { rx_buffer_size: 100 });
  await conn.sendBreak(30);
  assert.equal(port._lineLog.length, 2);
  assert.equal(port._lineLog[0].brk, true);
  assert.equal(port._lineLog[1].brk, false);
});

test("receive flush+reset 丢弃旧数据、捕获复位后横幅", async () => {
  const port = fakePort();
  const conn = new Connection(null, port, { rx_buffer_size: 100 });
  conn._onData(Buffer.from("OLD\n"));
  setTimeout(() => conn._onData(Buffer.from("BOOT OK\n")), 20);
  const r = await conn.receive({
    start: "flush",
    reset: "dtr",
    resetPulseMs: 10,
    idleTimeoutMs: 300,
    budgetMs: 2000,
  });
  assert.ok(!r.text.includes("OLD") && r.text.includes("BOOT OK"));
  assert.equal(r.reset, "dtr");
});

test("receive match 出现即停", async () => {
  const port = fakePort();
  const conn = new Connection(null, port, { rx_buffer_size: 100 });
  setTimeout(() => conn._onData(Buffer.from("Ready #\n")), 20);
  const r = await conn.receive({
    reset: "rts",
    resetPulseMs: 10,
    match: Buffer.from("#"),
    idleTimeoutMs: 200,
    budgetMs: 2000,
  });
  assert.ok(r.matched && r.text.includes("#"));
  assert.equal(r.stopped_reason, "match");
});

test("receive 静默即停", async () => {
  const port = fakePort();
  const conn = new Connection(null, port, { rx_buffer_size: 100 });
  setTimeout(() => conn._onData(Buffer.from("hi")), 20);
  const r = await conn.receive({ idleTimeoutMs: 100, budgetMs: 2000 });
  assert.equal(r.text, "hi");
  assert.equal(r.stopped_reason, "idle");
});

test("status 暴露当前残行", async () => {
  const logStore = new LogStore({ dir: null });
  const conn = new Connection(null, fakePort(), { rx_buffer_size: 100 }, logStore);
  conn._onData(Buffer.from("BOOT"));
  const st = conn.status();
  assert.equal(st.current_partial_line && st.current_partial_line.text, "BOOT");
  assert.equal(st.current_partial_line && st.current_partial_line.bytes, 4);
  assert.equal(typeof st.current_partial_line.started_at, "number");
});

test("receive match 不出现时不丢非匹配流量（回归）", async () => {
  const conn = new Connection(null, fakePort(), { rx_buffer_size: 1000 });
  setTimeout(() => conn._onData(Buffer.from("U-Boot 2023\nKernel\nmount root\n")), 10);
  setTimeout(() => conn._onData(Buffer.from("app started\n")), 60);
  const r = await conn.receive({ match: Buffer.from("login:"), idleTimeoutMs: 80, budgetMs: 800 });
  assert.ok(r.text.includes("U-Boot") && r.text.includes("app started"), `text=${r.text}`);
  assert.equal(r.matched, false);
  assert.ok(["idle", "budget"].includes(r.stopped_reason), `stop=${r.stopped_reason}`);
});

test("receive 非匹配前置数据 + 后续 match 跨到达补齐", async () => {
  const conn = new Connection(null, fakePort(), { rx_buffer_size: 1000 });
  setTimeout(() => conn._onData(Buffer.from("WARMING\n")), 10);
  setTimeout(() => conn._onData(Buffer.from("Rea")), 40);
  setTimeout(() => conn._onData(Buffer.from("dy F28\n")), 70);
  const r = await conn.receive({
    match: Buffer.from("Ready F28"),
    idleTimeoutMs: 80,
    budgetMs: 800,
  });
  assert.ok(r.text.includes("WARMING") && r.text.includes("Ready F28"), `text=${r.text}`);
  assert.equal(r.matched, true);
  assert.equal(r.stopped_reason, "match");
});

test("receive 从当前游标收集：只带回 receive 后流量，match 出现即停", async () => {
  const conn = new Connection(null, fakePort(), { rx_buffer_size: 1000 });
  conn._onData(Buffer.from("OLDNOISE\n"));
  await conn.read({ waitMs: 0 }); // 消费旧数据，handled 前移
  setTimeout(() => conn._onData(Buffer.from("----\n")), 20);
  setTimeout(() => conn._onData(Buffer.from("Data ERR here\n")), 60);
  const r = await conn.receive({ match: Buffer.from("ERR"), idleTimeoutMs: 100, budgetMs: 2000 });
  assert.equal(r.stopped_reason, "match");
  assert.ok(r.text.includes("----") && r.text.includes("ERR"), `text=${r.text}`);
  assert.ok(!r.text.includes("OLDNOISE"), "不应带回 receive 前旧数据");
});

test("RX 超 cap 丢弃时 dropped 计数暴露", async () => {
  const conn = new Connection(null, fakePort(), { rx_buffer_size: 4 });
  conn._onData(Buffer.from("abcdefgh")); // 超 cap，丢最旧 4 字节
  assert.equal(conn.dropped, 4);
  assert.equal(conn.status().rx_dropped, 4);
  conn._onData(Buffer.from("ijkl"));
  assert.equal(conn.dropped, 8);
});

test("receive start=flush 清旧缓冲 + cursor 覆盖 diff", async () => {
  const conn = new Connection(null, fakePort(), { rx_buffer_size: 1000 });
  conn._onData(Buffer.from("OLD\n"));
  const r = await conn.receive({ start: "flush", idleTimeoutMs: 80, budgetMs: 400 });
  assert.ok(!r.text.includes("OLD"), `text=${r.text}`);
});

test("dump_to_file 直落盘 + 结尾预览", async () => {
  const conn = new Connection(null, fakePort(), { rx_buffer_size: 1000 });
  setTimeout(() => conn._onData(Buffer.from("AAA\n")), 10);
  setTimeout(() => conn._onData(Buffer.from("BBB\n")), 40);
  const file = `${os.tmpdir()}/dump-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`;
  const r = await conn.dumpToFile({ file, idleTimeoutMs: 100, budgetMs: 800 });
  assert.equal(r.stopped_reason, "idle");
  assert.ok(r.bytes >= 8, `bytes=${r.bytes}`);
  assert.equal(fs.readFileSync(file, "utf8"), "AAA\nBBB\n");
  assert.ok(r.preview.includes("BBB"));
  fs.rmSync(file, { force: true });
});
