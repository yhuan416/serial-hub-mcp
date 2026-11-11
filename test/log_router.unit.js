import { test } from "node:test";
import assert from "node:assert/strict";
import { LogRouter } from "../src/log_router.js";

function fakeBackend(tag) {
  const calls = [];
  return {
    tag,
    calls,
    addData: (id, buf) => calls.push(["addData", id, buf.toString("utf8")]),
    addTx: (id, buf) => calls.push(["addTx", id, buf.toString("utf8")]),
    unregister: (id) => calls.push(["unregister", id]),
    currentPartial: (id) => ({ tag, id }),
    query: (opts) => ({ tag, query: opts }),
    stats: (id) => ({ tag, stats: id }),
    clear: (id) => ({ tag, clear: id }),
  };
}

test("未绑定连接默认走本地后端", () => {
  const local = fakeBackend("local");
  const router = new LogRouter(local);

  router.addData("c1", Buffer.from("hi"));
  router.addTx("c1", Buffer.from("AT"));
  assert.deepEqual(local.calls, [
    ["addData", "c1", "hi"],
    ["addTx", "c1", "AT"],
  ]);
  assert.deepEqual(router.query({ connection_id: "c1" }), {
    tag: "local",
    query: { connection_id: "c1" },
  });
  assert.deepEqual(router.stats("c1"), { tag: "local", stats: "c1" });
});

test("bind 后该连接的读写/查询都路由到远端后端", () => {
  const local = fakeBackend("local");
  const remote = fakeBackend("device");
  const router = new LogRouter(local);
  router.bind("r1", remote);

  router.addData("r1", Buffer.from("abc"));
  router.addTx("r1", Buffer.from("xyz"));
  assert.deepEqual(remote.calls, [
    ["addData", "r1", "abc"],
    ["addTx", "r1", "xyz"],
  ]);
  assert.equal(local.calls.length, 0);

  assert.equal(router.query({ connection_id: "r1" }).tag, "device");
  assert.equal(router.currentPartial("r1").tag, "device");
  // 其它连接不受影响
  assert.equal(router.query({ connection_id: "c1" }).tag, "local");
});

test("unbind 回落到本地；unregister 会解除绑定", () => {
  const local = fakeBackend("local");
  const remote = fakeBackend("device");
  const router = new LogRouter(local);
  router.bind("r1", remote);
  router.unbind("r1");
  router.addData("r1", Buffer.from("x"));
  assert.equal(remote.calls.length, 0);
  assert.deepEqual(local.calls, [["addData", "r1", "x"]]);

  router.bind("r2", remote);
  router.unregister("r2");
  assert.deepEqual(remote.calls, [["unregister", "r2"]]);
  router.addData("r2", Buffer.from("y"));
  assert.deepEqual(local.calls, [
    ["addData", "r1", "x"],
    ["addData", "r2", "y"],
  ]);
});

test("无本地后端且未绑定 → 查询报错", () => {
  const router = new LogRouter(null);
  assert.throws(() => router.query({ connection_id: "x" }), /日志功能未启用/);
  assert.doesNotThrow(() => router.addData("x", Buffer.from("a")));
});

test("全查聚合本地 + 远端，并可显式全量清理", async () => {
  const local = {
    calls: [],
    addData() {},
    addTx() {},
    unregister() {},
    currentPartial() {
      return null;
    },
    async query(opts) {
      this.calls.push(["query", opts]);
      return {
        entries: [{ seq: 1, conn: "c1", line: "local" }],
        count: 1,
        truncated: false,
        earliest_seq: 1,
      };
    },
    async stats() {
      return { total: 1, connections: [{ connection_id: "c1", total: 1 }] };
    },
    async clear() {
      this.calls.push(["clear"]);
      return { cleared: true };
    },
  };
  const remote = {
    calls: [],
    addData() {},
    addTx() {},
    unregister() {},
    currentPartial() {
      return null;
    },
    async query(opts) {
      this.calls.push(["query", opts]);
      return {
        entries: [{ seq: 2, line: "remote" }],
        count: 1,
        truncated: false,
        source: "device",
        earliest_seq: 2,
      };
    },
    async stats() {
      return { total: 2, source: "device" };
    },
    async clear(id, opts) {
      this.calls.push(["clear", id, opts]);
      return { cleared: true };
    },
  };
  const router = new LogRouter(local);
  router.bind("r1", remote);

  const q = await router.query({});
  assert.equal(q.scope, "all");
  assert.equal(q.count, 2);
  assert.deepEqual(
    q.entries.map((e) => e.connection_id ?? e.conn),
    ["c1", "r1"],
  );
  assert.equal(q.sources.length, 2);

  const st = await router.stats();
  assert.equal(st.scope, "all");
  assert.equal(st.total, 3);
  assert.equal(st.remote.length, 1);

  await assert.rejects(router.clear(), /confirm=true/);
  const c = await router.clear(undefined, { confirm: true });
  assert.equal(c.cleared.length, 2);
  assert.deepEqual(remote.calls.at(-1), ["clear", "r1", { confirm: true }]);
});
