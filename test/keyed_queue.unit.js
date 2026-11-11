import { test } from "node:test";
import assert from "node:assert/strict";
import { keyedSerialQueue } from "../src/keyed_queue.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("同 key 严格串行，不同 key 互不阻塞", async () => {
  const q = keyedSerialQueue();
  const order = [];
  let releaseA;
  const gate = new Promise((r) => {
    releaseA = r;
  });

  const a1 = q.run("A", async () => {
    order.push("a1:start");
    await gate;
    order.push("a1:end");
  });
  const b1 = q.run("B", async () => {
    order.push("b1");
  });
  const a2 = q.run("A", async () => {
    order.push("a2");
  });

  // B 不被 A 阻塞：A 卡在 gate 时 B 应先完成
  await b1;
  assert.deepEqual(order, ["a1:start", "b1"]);

  releaseA();
  await Promise.all([a1, a2]);
  assert.deepEqual(order, ["a1:start", "b1", "a1:end", "a2"]);
});

test("key 为空/undefined 归入全局队列", async () => {
  const q = keyedSerialQueue();
  const order = [];
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const g1 = q.run(undefined, async () => {
    order.push("g1:start");
    await gate;
    order.push("g1:end");
  });
  const g2 = q.run(null, async () => {
    order.push("g2");
  });
  await tick(5);
  assert.deepEqual(order, ["g1:start"]);
  release();
  await Promise.all([g1, g2]);
  assert.deepEqual(order, ["g1:start", "g1:end", "g2"]);
});

test("任务抛错不阻塞同 key 后续任务，且错误透传给调用方", async () => {
  const q = keyedSerialQueue();
  await assert.rejects(
    q.run("X", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  const v = await q.run("X", async () => 42);
  assert.equal(v, 42);
});

test("队列空闲后清理 key（不无限累积）", async () => {
  const q = keyedSerialQueue();
  await q.run("A", async () => {});
  await q.run("B", async () => {});
  await tick(5);
  assert.equal(q.size(), 0);
});
