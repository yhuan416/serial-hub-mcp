import { test } from "node:test";
import assert from "node:assert/strict";

import { RemoteLogStore } from "../src/remote/log_store.js";

function makeEntries(n, needleAt = -1) {
  return Array.from({ length: n }, (_, i) => {
    const seq = i + 1;
    return {
      seq,
      dir: "rx",
      line: seq === needleAt ? "line needle" : `line ${seq}`,
      bytes: 8,
    };
  });
}

function mockStore(entries, opts = {}) {
  const calls = [];
  const rpc = {
    async request(op, params) {
      calls.push({ op, params });
      if (op === "LOG_STATS") {
        return {
          storage: "raw+index",
          capacity_bytes: 1000,
          used_bytes: 100,
          earliest_seq: opts.sdEarliest ?? entries[0]?.seq ?? null,
          latest_seq: entries.at(-1)?.seq ?? null,
          ram_earliest_seq: opts.ramEarliest ?? entries[0]?.seq ?? null,
          ram_latest_seq: entries.at(-1)?.seq ?? null,
          sd_earliest_seq: opts.sdEarliest ?? entries[0]?.seq ?? null,
          sd_latest_seq: entries.at(-1)?.seq ?? null,
        };
      }
      if (op === "LOG_QUERY") {
        let list = entries;
        if (params.dir) list = list.filter((e) => e.dir === params.dir);
        if (params.cursor) list = list.filter((e) => e.seq > Number(params.cursor));
        if (Number.isFinite(params.seq_from)) list = list.filter((e) => e.seq >= params.seq_from);
        if (Number.isFinite(params.seq_to)) list = list.filter((e) => e.seq <= params.seq_to);
        const limit = params.limit ?? 100;
        const page = list.slice(0, limit);
        return {
          entries: page,
          count: page.length,
          truncated: list.length > page.length,
          next_cursor: page.length ? String(page.at(-1).seq) : null,
          earliest_seq: entries[0]?.seq ?? null,
          ram_earliest_seq: opts.ramEarliest ?? entries[0]?.seq ?? null,
          ram_latest_seq: entries.at(-1)?.seq ?? null,
          sd_earliest_seq: opts.sdEarliest ?? entries[0]?.seq ?? null,
          sd_latest_seq: entries.at(-1)?.seq ?? null,
          source: "device",
          time_source: "tick",
        };
      }
      if (op === "LOG_CLEAR") return { cleared: true };
      if (op === "LOG_EXPORT") {
        return { chunk_b64: "", index_b64: "", bytes: 0, eof: true, next_cursor: null };
      }
      throw new Error(`unexpected op ${op}`);
    },
  };
  return { store: new RemoteLogStore({ id: "conn-1", config: {}, rpc }), calls };
}

test("RemoteLogStore: desc 默认从最新开始", async () => {
  const { store, calls } = mockStore(makeEntries(10));
  const r = await store.query({ order: "desc", limit: 3 });
  assert.deepEqual(
    r.entries.map((e) => e.seq),
    [10, 9, 8],
  );
  assert.equal(r.ram_latest_seq, 10);
  assert.equal(r.sd_earliest_seq, 1);
  assert.equal(r.truncated, true);
  assert.equal(r.next_cursor, 7);
  const q = calls.find((c) => c.op === "LOG_QUERY");
  assert.equal(q.params.seq_from, 8);
  assert.equal(q.params.seq_to, 10);
});

test("RemoteLogStore: desc + contains 跨页向前扫描", async () => {
  const { store, calls } = mockStore(makeEntries(1000, 100));
  const r = await store.query({ order: "desc", contains: "needle", limit: 2 });
  assert.deepEqual(
    r.entries.map((e) => e.seq),
    [100],
  );
  assert.equal(r.scanned, 1000);
  assert.equal(r.pages, 2);
  assert.equal(r.entries[0].line, "line needle");
  assert.equal(calls.filter((c) => c.op === "LOG_QUERY").length, 2);
});

test("RemoteLogStore: asc + contains 跨页向后扫描", async () => {
  const { store } = mockStore(makeEntries(1000, 900));
  const r = await store.query({ contains: "needle", limit: 2 });
  assert.deepEqual(
    r.entries.map((e) => e.seq),
    [900],
  );
  assert.equal(r.scanned, 1000);
  assert.equal(r.pages, 2);
});

test("RemoteLogStore: ram/sd earliest 分开返回，time_filter 明确忽略", async () => {
  const { store } = mockStore(makeEntries(10), { ramEarliest: 5, sdEarliest: 1 });
  const r = await store.query({ time_from: 1, limit: 2 });
  assert.equal(r.ram_earliest_seq, 5);
  assert.equal(r.sd_earliest_seq, 1);
  assert.match(r.time_filter, /ignored/);
});

test("RemoteLogStore: clear/export 传递 segment", async () => {
  const { store, calls } = mockStore(makeEntries(2));
  await store.clear("conn-1", { segment: "seg-a" });
  assert.equal(calls.at(-1).params.segment, "seg-a");
  await store.export({ segment: "seg-b" });
  assert.equal(calls.at(-1).params.segment, "seg-b");
});
