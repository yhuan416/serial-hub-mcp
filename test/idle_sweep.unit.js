import { test } from "node:test";
import assert from "node:assert/strict";
import { closeIdleConnections, startIdleSweep } from "../src/idle_sweep.js";

function fakeManager(rows) {
  const closed = [];
  return {
    closed,
    list: () => rows,
    close: async (id) => {
      closed.push(id);
      return { connection_id: id };
    },
  };
}

test("closeIdleConnections: 只关超过阈值的连接", async () => {
  const manager = fakeManager([
    { connection_id: "fresh", idle_ms: 1_000, port: "/dev/ttyACM0" },
    { connection_id: "exact", idle_ms: 600_000, port: "/dev/ttyACM1" },
    { connection_id: "stale", idle_ms: 1_200_000, port: "ttyACM2" },
  ]);
  const logs = [];
  const closed = await closeIdleConnections(manager, 600_000, { log: (m) => logs.push(m) });
  assert.deepEqual(closed, ["exact", "stale"]);
  assert.deepEqual(manager.closed, ["exact", "stale"]);
  assert.equal(logs.length, 2);
});

test("closeIdleConnections: 0 或非法阈值不动作", async () => {
  const manager = fakeManager([{ connection_id: "a", idle_ms: 10_000_000 }]);
  assert.deepEqual(await closeIdleConnections(manager, 0), []);
  assert.deepEqual(manager.closed, []);
});

test("closeIdleConnections: 单条关闭失败不影响其它", async () => {
  const manager = fakeManager([
    { connection_id: "bad", idle_ms: 10_000_000 },
    { connection_id: "ok", idle_ms: 10_000_000 },
  ]);
  const realClose = manager.close;
  manager.close = async (id) => {
    if (id === "bad") throw new Error("boom");
    return realClose(id);
  };
  const closed = await closeIdleConnections(manager, 1000, { log: () => {} });
  assert.deepEqual(closed, ["ok"]);
});

test("startIdleSweep: minutes<=0 返回 null", () => {
  assert.equal(startIdleSweep(fakeManager([]), { minutes: 0 }), null);
  assert.equal(startIdleSweep(fakeManager([]), { minutes: -5 }), null);
});

test("startIdleSweep: 定时触发回收并可停止", async () => {
  const manager = fakeManager([{ connection_id: "idle", idle_ms: 10_000 }]);
  const sweep = startIdleSweep(manager, { minutes: 0.001, intervalMs: 5, log: () => {} });
  assert.ok(sweep);
  await new Promise((r) => setTimeout(r, 40));
  sweep.stop();
  assert.ok(manager.closed.includes("idle"));
});
