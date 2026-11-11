import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ConnectionManager } from "../src/connection.js";
import { createLink } from "../src/links/index.js";

function fakePort() {
  const p = new EventEmitter();
  p.path = "/dev/fake0";
  p.open = (cb) => cb();
  p.close = (cb) => cb();
  p.write = (b, cb) => cb(null);
  p.drain = (cb) => cb();
  p.flush = (cb) => cb();
  p.set = (opts, cb) => cb();
  return p;
}

test("serial 默认：status 带 transport/endpoint，local 行为不变", async () => {
  const m = new ConnectionManager(null, { linkFactory: () => fakePort() });
  const st = await m.open({ port: "/dev/fake0", baud_rate: 9600 });
  assert.equal(st.transport, "serial");
  assert.equal(st.endpoint, null);
  assert.equal(st.port, "/dev/fake0");
  assert.equal(st.config.baud_rate, 9600);
  assert.equal(st.open, true);
  await m.close(st.connection_id);
});

test("serial 缺 port 报错", async () => {
  const m = new ConnectionManager(null, { linkFactory: () => fakePort() });
  await assert.rejects(() => m.open({}), /port/);
});

test("未知 transport 报错", async () => {
  const m = new ConnectionManager(null, { linkFactory: () => fakePort() });
  await assert.rejects(() => m.open({ transport: "ws", port: "/dev/x" }), /transport 非法/);
});

test("remote 缺 endpoint 报错", async () => {
  const m = new ConnectionManager(null, { linkFactory: createLink });
  await assert.rejects(() => m.open({ transport: "remote" }), /endpoint/);
});

test("remote 当前明确报未实现（接缝已就位）", async () => {
  const m = new ConnectionManager(null, { linkFactory: createLink });
  await assert.rejects(
    () => m.open({ transport: "remote", endpoint: "tcp://esp32s3-01:7000" }),
    /尚未实现/,
  );
});

test("remote 注入假链路时，status 保留 transport/endpoint", async () => {
  const m = new ConnectionManager(null, { linkFactory: () => fakePort() });
  const st = await m.open({ transport: "remote", endpoint: "tcp://esp32s3-01:7000" });
  assert.equal(st.transport, "remote");
  assert.equal(st.endpoint, "tcp://esp32s3-01:7000");
  assert.equal(st.port, "tcp://esp32s3-01:7000");
  await m.close(st.connection_id);
});
