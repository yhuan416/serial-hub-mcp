import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RemoteLogStore } from "../src/remote/log_store.js";

function idxRecord(off, seq, tick, len, dir) {
  const b = Buffer.alloc(20);
  b.writeBigUInt64LE(BigInt(off), 0);
  b.writeUInt32LE(seq, 8);
  b.writeUInt32LE(tick, 12);
  b.writeUInt16LE(len, 16);
  b.writeUInt8(dir, 18);
  return b;
}

function mockConn() {
  const calls = [];
  const rpc = {
    async request(op, params) {
      calls.push({ op, params });
      if (op === "LOG_QUERY") {
        return {
          entries: [
            { seq: 1, dir: "rx", line: "hello", bytes: 5 },
            { seq: 2, dir: "rx", line: "world", bytes: 5 },
            { seq: 3, dir: "rx", line: "hello again", bytes: 11 },
          ],
          count: 3,
          truncated: false,
          next_cursor: "3",
          earliest_seq: 1,
          time_source: "tick",
        };
      }
      if (op === "LOG_STATS") {
        return {
          storage: "raw+index",
          capacity_bytes: 1000,
          used_bytes: 100,
          earliest_seq: 1,
          latest_seq: 3,
          ring: { used: 10, dropped_bytes: 0 },
        };
      }
      if (op === "LOG_CLEAR") return { cleared: true };
      if (op === "LOG_EXPORT") {
        const chunk = Buffer.from("hello\nworld\n");
        const index = Buffer.concat([idxRecord(0, 1, 10, 6, 0), idxRecord(6, 2, 20, 6, 0)]);
        return {
          chunk_b64: chunk.toString("base64"),
          index_b64: index.toString("base64"),
          bytes: chunk.length,
          eof: true,
          next_cursor: null,
        };
      }
      throw new Error(`unexpected op ${op}`);
    },
  };
  return { conn: { id: "conn-1", config: {}, rpc }, calls };
}

test("RemoteLogStore: query / stats / clear proxy to device", async () => {
  const { conn, calls } = mockConn();
  const store = new RemoteLogStore(conn);

  const q = await store.query({ dir: "rx", contains: "hello" });
  assert.equal(q.source, "device");
  assert.equal(q.authoritative, true);
  assert.equal(q.count, 2);
  assert.deepEqual(
    q.entries.map((e) => e.seq),
    [1, 3],
  );
  assert.equal(calls[0].op, "LOG_QUERY");
  assert.equal(calls[0].params.dir, "rx");

  const st = await store.stats();
  assert.equal(st.storage, "raw+index");
  assert.equal(st.capacity_bytes, 1000);
  assert.equal(calls[1].op, "LOG_STATS");

  const cl = await store.clear();
  assert.equal(cl.cleared, true);
  assert.equal(calls[2].op, "LOG_CLEAR");
});

test("RemoteLogStore: export writes reconstructed lines", async () => {
  const { conn, calls } = mockConn();
  const store = new RemoteLogStore(conn);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shb-")), "out.log");

  const r = await store.export({ dir: "rx", seq_from: 1, path: file });
  assert.equal(r.lines, 2);
  assert.equal(r.bytes, 12);
  assert.equal(r.eof, true);
  assert.equal(r.first_seq, 1);
  assert.equal(r.last_seq, 2);
  assert.equal(fs.readFileSync(file, "utf8"), "hello\nworld\n");
  assert.equal(calls.at(-1).op, "LOG_EXPORT");
  assert.equal(calls.at(-1).params.dir, "rx");
  assert.equal(calls.at(-1).params.seq_from, 1);
});

test("RemoteLogStore: remote connection does not write host logs", () => {
  const { conn } = mockConn();
  const store = new RemoteLogStore(conn);
  assert.doesNotThrow(() => store.addData("x", Buffer.from("y")));
  assert.doesNotThrow(() => store.addTx("x", Buffer.from("y")));
  assert.equal(store.currentPartial(), null);
  assert.doesNotThrow(() => store.unregister());
});
