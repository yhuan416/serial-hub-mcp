import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeBridge } from "../test-utils/fake_bridge.js";
import { ConnectionManager } from "../src/connection.js";
import { LogStore } from "../src/log_store.js";
import { LogRouter } from "../src/log_router.js";

async function startHub(opts) {
  const bridge = new FakeBridge(opts);
  const port = await bridge.start();
  const router = new LogRouter(new LogStore({ dir: null }));
  const manager = new ConnectionManager(router);
  return { bridge, port, manager, endpoint: `tcp://127.0.0.1:${port}` };
}

async function stopHub(h) {
  await h.manager.closeAll();
  await h.bridge.stop();
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test("remote tcp: open/status/write/read 回环", async () => {
  const h = await startHub();
  try {
    const st = await h.manager.open({
      transport: "remote",
      endpoint: h.endpoint,
      baud_rate: 921600,
    });
    assert.equal(st.transport, "remote");
    assert.equal(st.endpoint, h.endpoint);
    assert.equal(st.port, h.endpoint);
    assert.equal(st.open, true);
    assert.equal(st.remote.fw_version, "fake-0.1.0");
    assert.equal(st.remote.caps.can_set_lines, true);
    assert.equal(st.config.token, null);
    assert.equal(h.bridge.configs.length, 1);
    assert.equal(h.bridge.configs[0].baud_rate, 921600);

    const conn = h.manager.get(st.connection_id);
    assert.equal(await conn.write(Buffer.from("AT\r\n")), 4);
    const r = await conn.read({ waitMs: 500 });
    assert.equal(r.data.toString(), "AT\r\n");
    assert.equal(r.matched, false);
  } finally {
    await stopHub(h);
  }
});

test("remote tcp: transact 屏障排除写前数据并匹配", async () => {
  const h = await startHub({ onWrite: () => Buffer.from("PONG\r\n") });
  try {
    const st = await h.manager.open({ transport: "remote", endpoint: h.endpoint });
    const conn = h.manager.get(st.connection_id);

    h.bridge.pushData("NOISE");
    await tick(10);

    const r = await conn.transact(Buffer.from("PING\r\n"), {
      match: Buffer.from("PONG"),
      waitMs: 1000,
    });
    assert.equal(r.data.toString(), "PONG");
    assert.equal(r.matched, true);
    assert.ok(r.start_offset >= 5, `start_offset=${r.start_offset} 应 >= NOISE 长度`);
  } finally {
    await stopHub(h);
  }
});

test("remote tcp: receive 窗口持续到 match", async () => {
  const h = await startHub();
  try {
    const st = await h.manager.open({ transport: "remote", endpoint: h.endpoint });
    const conn = h.manager.get(st.connection_id);

    const pending = conn.receive({
      match: Buffer.from("DONE"),
      budgetMs: 1000,
      idleTimeoutMs: 200,
    });
    setTimeout(() => h.bridge.pushData("abcDONE"), 20);
    const frame = await pending;

    assert.equal(frame.matched, true);
    assert.equal(frame.stopped_reason, "match");
    assert.ok(frame.text.includes("DONE"));
    assert.equal(frame.timed_out, false);
  } finally {
    await stopHub(h);
  }
});

test("remote tcp: dump_to_file 落盘", async () => {
  const h = await startHub();
  try {
    const st = await h.manager.open({ transport: "remote", endpoint: h.endpoint });
    const conn = h.manager.get(st.connection_id);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serial-hub-remote-"));
    const file = path.join(dir, "dump.log");

    const pending = conn.dumpToFile({
      file,
      budgetMs: 1000,
      idleTimeoutMs: 150,
      maxBytes: 1024,
    });
    setTimeout(() => h.bridge.pushData("hello\n"), 20);
    const r = await pending;

    assert.equal(r.bytes, 6);
    assert.equal(fs.readFileSync(file, "utf8"), "hello\n");
    assert.equal(r.timed_out, true);
  } finally {
    await stopHub(h);
  }
});

test("remote tcp: set_dtr_rts / send_break", async () => {
  const h = await startHub();
  try {
    const st = await h.manager.open({ transport: "remote", endpoint: h.endpoint });
    const conn = h.manager.get(st.connection_id);

    const line = await conn.setLine({ dtr: true, rts: false });
    assert.deepEqual(line, { dtr: true, rts: false });
    assert.deepEqual(h.bridge.lastLines, { dtr: true, rts: false });

    await conn.sendBreak(50);
    assert.deepEqual(h.bridge.breaks, [50]);
    assert.equal(conn.status().dtr, true);
  } finally {
    await stopHub(h);
  }
});

test("remote tcp: token 鉴权失败/成功", async () => {
  const h = await startHub({ token: "s3cr3t" });
  try {
    await assert.rejects(
      () => h.manager.open({ transport: "remote", endpoint: h.endpoint, token: "bad" }),
      /unauthorized|bad token/,
    );

    const st = await h.manager.open({ transport: "remote", endpoint: h.endpoint, token: "s3cr3t" });
    assert.ok(st.connection_id);
    assert.equal(st.config.token, "***");
  } finally {
    await stopHub(h);
  }
});

test("remote tcp: can_set_lines=false 时拒绝控制线", async () => {
  const h = await startHub({ caps: { can_set_lines: false } });
  try {
    const st = await h.manager.open({ transport: "remote", endpoint: h.endpoint });
    const conn = h.manager.get(st.connection_id);
    await assert.rejects(() => conn.setLine({ dtr: true }), /can_set_lines/);
  } finally {
    await stopHub(h);
  }
});

test("remote tcp: flushInput 丢弃已缓存", async () => {
  const h = await startHub();
  try {
    const st = await h.manager.open({ transport: "remote", endpoint: h.endpoint });
    const conn = h.manager.get(st.connection_id);

    h.bridge.pushData("stale");
    await tick(20);
    await conn.flushInput();
    const r = await conn.read({ waitMs: 100 });
    assert.equal(r.data.length, 0);
    assert.equal(r.timed_out, true);
  } finally {
    await stopHub(h);
  }
});

test("remote: 未注册 scheme 报错", async () => {
  const h = await startHub();
  try {
    await assert.rejects(
      () => h.manager.open({ transport: "remote", endpoint: "kcp://127.0.0.1:1" }),
      /尚未实现/,
    );
  } finally {
    await stopHub(h);
  }
});
