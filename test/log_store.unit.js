import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LogStore } from "../src/log_store.js";

test("行切分：\\n 与 \\r\\n；末尾无换行是残行", async () => {
  const s = new LogStore({ dir: null, memEntries: 100 });
  s.addData("c1", Buffer.from("AT\r\nOK\r\nERR"));
  const q = await s.query({ connection_id: "c1" });
  assert.equal(q.entries.map((e) => e.line).join(","), "AT,OK");
  assert.ok(q.entries.every((e) => e.dir === "rx"));
  assert.ok(q.entries.every((e) => e.seq > 0 && e.ts > 0));
});

test("跨 chunk 残行累积", async () => {
  const s = new LogStore({ dir: null });
  s.addData("c2", Buffer.from("HEL"));
  s.addData("c2", Buffer.from("LO\nWORL"));
  s.addData("c2", Buffer.from("D\nEND"));
  const q = await s.query({ connection_id: "c2" });
  assert.equal(q.entries.map((e) => e.line).join(","), "HELLO,WORLD");
  assert.equal(q.current_partial && q.current_partial.text, "END");
  assert.equal(q.current_partial && q.current_partial.bytes, 3);
  assert.ok(
    q.current_partial.started_at > 0 &&
      q.current_partial.updated_at >= q.current_partial.started_at,
  );
});

test("TX 记一条", async () => {
  const s = new LogStore({ dir: null });
  s.addTx("c3", Buffer.from("AT+VER?\r\n"));
  const q = await s.query({ connection_id: "c3" });
  assert.equal(q.entries.length, 1);
  assert.equal(q.entries[0].dir, "tx");
});

test("溢出落盘：内存保留 N 条其余落盘", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serial_hub_mcp-log-"));
  try {
    const s = new LogStore({ dir, memEntries: 2 });
    s.addData("c4", Buffer.from("L1\nL2\nL3\nL4\n"));
    const q = await s.query({ connection_id: "c4" });
    assert.equal(q.total, 4);
    assert.equal(q.entries.map((e) => e.line).join(","), "L1,L2,L3,L4");
    const st = s.stats("c4");
    const conn = st.connections[0];
    assert.equal(conn.disk, 2);
    assert.equal(conn.memory, 2);
    assert.ok(conn.partitions === 1 && conn.disk_bytes > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("检索：dir / contains / regex / seq / order / time", async () => {
  const s = new LogStore({ dir: null, memEntries: 100 });
  s.addData("c5", Buffer.from("error: timeout\nhello\nhello world\n"));
  s.addTx("c5", Buffer.from("ping"));
  const byDir = await s.query({ connection_id: "c5", dir: "rx" });
  assert.equal(byDir.count, 3);
  const byContains = await s.query({ connection_id: "c5", contains: "hello" });
  assert.equal(byContains.count, 2);
  assert.ok(byContains.entries.every((e) => e.dir === "rx"));
  const byRegex = await s.query({ connection_id: "c5", regex: "^error" });
  assert.equal(byRegex.count, 1);
  assert.equal(byRegex.entries[0].line, "error: timeout");
  const bySeq = await s.query({ connection_id: "c5", seq_from: 1, seq_to: 2 });
  assert.equal(bySeq.count, 2);
  const desc = await s.query({ connection_id: "c5", order: "desc", limit: 2 });
  assert.ok(desc.entries[0].seq > desc.entries[1].seq);
  const byTime = await s.query({ connection_id: "c5", time_to: Date.now() + 100000 });
  assert.equal(byTime.count, byTime.total);
});

test("unregister flush 残行", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serial_hub_mcp-log-"));
  try {
    const s = new LogStore({ dir, memEntries: 100 });
    s.addData("c6", Buffer.from("START\nPARTIAL"));
    s.unregister("c6");
    const q = await s.query({ connection_id: "c6" });
    assert.equal(q.entries.map((e) => e.line).join(","), "START,PARTIAL");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clear", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serial_hub_mcp-log-"));
  try {
    const s = new LogStore({ dir, memEntries: 100 });
    s.addData("c7", Buffer.from("x\ny\n"));
    const before = (await s.query({ connection_id: "c7" })).total;
    assert.equal(before, 2);
    s.clear("c7");
    const after = (await s.query({ connection_id: "c7" })).total;
    assert.equal(after, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("跨连接全查 order=asc 按 seq 全局升序（回归：磁盘+内存归并不再乱序）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serial_hub_mcp-log-"));
  try {
    const s = new LogStore({ dir, memEntries: 2 });
    // 交错写入制造 seq 区间跨连接穿插 + 部分落盘的场景
    s.addData("cA", Buffer.from("a1\na2\na3\n"));
    s.addData("cB", Buffer.from("b1\nb2\nb3\n"));
    s.addData("cA", Buffer.from("a4\na5\na6\n"));
    const q = await s.query({ order: "asc", limit: 30 });
    const seqs = q.entries.map((e) => e.seq);
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("分区轮转：小 part_bytes 切多个分片文件，q 仍按 seq 升序可读", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serial_hub_mcp-log-"));
  try {
    const s = new LogStore({ dir, memEntries: 3, partBytes: 60 }); // 每条约 50-60B，几条即滚动
    for (let i = 0; i < 30; i += 1)
      s.addData("cP", Buffer.from(`L${String(i).padStart(2, "0")}\n`));
    const q = await s.query({ connection_id: "cP", limit: 50 });
    assert.equal(q.total, 30);
    const seqs = q.entries.map((e) => e.seq);
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
    );
    const st = s.stats("cP");
    assert.ok(st.connections[0].partitions >= 2, `partitions=${st.connections[0].partitions}`);
    assert.equal(st.connections[0].disk + st.connections[0].memory, 30);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("淘汰：小 retain_bytes 删最旧分片，earliest_seq 上移、evicted_lines 计数", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serial_hub_mcp-log-"));
  try {
    const s = new LogStore({ dir, memEntries: 2, partBytes: 60, retainBytes: 130 });
    for (let i = 0; i < 20; i += 1)
      s.addData("cR", Buffer.from(`E${String(i).padStart(2, "0")}\n`));
    const q = await s.query({ connection_id: "cR", limit: 50 });
    assert.ok(q.total < 20, `total=${q.total}（最旧分片应被淘汰）`);
    assert.ok(q.earliest_seq > 1, `earliest_seq=${q.earliest_seq}`);
    assert.ok(q.retention.evicted_lines > 0, `evicted=${q.retention.evicted_lines}`);
    const st = s.stats("cR");
    assert.equal(st.connections[0].evicted_lines, q.retention.evicted_lines);
    // 磁盘目录只剩分片文件，不残留旧平铺文件
    const files = fs.readdirSync(s._connDir("cR"));
    assert.ok(
      files.every((f) => /^part-\d{6}\.jsonl$/.test(f)),
      `files=${files}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("time_from/time_to 分片级裁剪：命中与越界的 entry 都能取对", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serial_hub_mcp-log-"));
  try {
    const s = new LogStore({ dir, memEntries: 100, partBytes: 40 }); // 强制多分片
    // 分批写入并加延时，让分片间 ts 有区分度（否则同毫秒 ts 会使裁剪退化为整分区跳过）
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let b = 0; b < 4; b += 1) {
      s.addData("cT", Buffer.from(`T${b}0\nT${b}1\nT${b}2\nT${b}3\n`));
      await sleep(6);
    }
    const all = (await s.query({ connection_id: "cT", limit: 50 })).entries;
    const mid = all[Math.floor(all.length / 2)].ts;
    const before = (await s.query({ connection_id: "cT", time_to: mid - 1, limit: 50 })).entries;
    const after = (await s.query({ connection_id: "cT", time_from: mid + 1, limit: 50 })).entries;
    assert.ok(
      before.length > 0 && after.length > 0,
      `before=${before.length} after=${after.length}`,
    );
    assert.ok(before.every((e) => e.ts <= mid));
    assert.ok(after.every((e) => e.ts >= mid));
    assert.ok(before.length + after.length <= all.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
