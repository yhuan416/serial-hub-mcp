// v1 协议：HELLO / SUBSCRIBE / DATA / ACK / resume / gap / writer。

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { HubServer } from "../src/hub-server/server.js";
import { T, encodeFrame, encodeAckFrame, decodeFrames } from "../src/hub-server/v1.js";

class FakeSerial extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.isOpen = true;
    this.writes = [];
  }
  write(buf, cb) {
    this.writes.push(Buffer.from(buf));
    if (cb) cb();
  }
  set(_o, cb) {
    if (cb) cb();
  }
  update(_o, cb) {
    if (cb) cb();
  }
  open(cb) {
    if (cb) cb();
  }
  close(cb) {
    this.isOpen = false;
    if (cb) cb();
  }
  emitData(buf) {
    this.emit("data", Buffer.from(buf));
  }
}

class V1Client {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.queue = [];
    this.waiters = [];
    socket.on("data", (chunk) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      const { frames, rest } = decodeFrames(this.buf);
      this.buf = rest;
      for (const f of frames) {
        this.queue.push(f);
        this._notify();
      }
    });
  }
  _notify() {
    for (let i = 0; i < this.waiters.length; i += 1) {
      const w = this.waiters[i];
      const idx = this.queue.findIndex(w.pred);
      if (idx >= 0) {
        const [f] = this.queue.splice(idx, 1);
        this.waiters.splice(i, 1);
        i -= 1;
        clearTimeout(w.timer);
        w.resolve(f);
      }
    }
  }
  wait(type, pred = () => true, timeout = 2000) {
    const match = (f) => f.type === type && pred(f);
    return new Promise((resolve, reject) => {
      const idx = this.queue.findIndex(match);
      if (idx >= 0) {
        const [f] = this.queue.splice(idx, 1);
        return resolve(f);
      }
      const w = { pred: match, resolve, timer: null };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`timeout waiting frame type ${type}`));
      }, timeout);
      this.waiters.push(w);
    });
  }
  send(buf) {
    this.socket.write(buf);
  }
  async hello(token) {
    this.send(
      encodeFrame(T.HELLO, 0, Buffer.from(JSON.stringify({ token, client_id: "t" }))),
    );
    const f = await this.wait(T.HELLO_ACK);
    return JSON.parse(f.payload.toString("utf8"));
  }
  async control(op, params = {}) {
    const id = params.id ?? Math.floor(Math.random() * 1e9);
    this.send(encodeFrame(T.CONTROL, 0, Buffer.from(JSON.stringify({ id, op, ...params }))));
    const f = await this.wait(T.CONTROL, (x) => JSON.parse(x.payload.toString()).id === id);
    return JSON.parse(f.payload.toString("utf8"));
  }
  ack(slot, captureId, offset, seq = 0) {
    this.send(encodeAckFrame({ slot, captureId, offset, seq }));
  }
  async data(pred = () => true) {
    const f = await this.wait(T.DATA, pred);
    const p = f.payload;
    return {
      slot: p[0],
      captureId: Number(p.readBigUInt64LE(1)),
      seq: p.readUInt32LE(9),
      offset: Number(p.readBigUInt64LE(13)),
      ts: Number(p.readBigUInt64LE(21)),
      flags: p[29],
      data: p.subarray(30),
    };
  }
}

async function setup(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shub-v1-"));
  const serials = new Map();
  const server = new HubServer({
    dataDir: dir,
    token: "t1",
    fwVersion: "test",
    listPorts: async () => [{ path: "/dev/ttyFAKE0" }],
    serialFactory: (_p, settings) => {
      const s = new FakeSerial(settings);
      serials.set("ttyFAKE0", s);
      return s;
    },
    scanIntervalMs: 600000,
    captureLingerMs: 200,
    captureMaxBytes: 4096,
    v1LeaseMs: 60000,
    ...opts,
  });
  const addr = await server.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const connect = () =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: addr.port }, () => {
        resolve(new V1Client(socket));
      });
      socket.on("error", reject);
    });
  return { server, port: addr.port, serials, connect };
}

test("v1: HELLO/CONFIG/SUBSCRIBE/DATA/ACK", async (t) => {
  const { connect, serials } = await setup(t);
  const c = await connect();
  const hello = await c.hello("t1");
  assert.equal(hello.ok, true);
  assert.equal(hello.result.proto, undefined);
  assert.equal(hello.result.caps.push, true);

  const cfg = await c.control("config", { port: "ttyFAKE0", baud_rate: 921600 });
  assert.equal(cfg.ok, true);
  assert.equal(cfg.result.port, "ttyFAKE0");

  const sub = await c.control("subscribe", { port: "ttyFAKE0" });
  assert.equal(sub.ok, true);
  assert.equal(sub.result.mode, "new");
  assert.equal(sub.result.writer, true);
  const { capture_id, port_slot } = sub.result;

  serials.get("ttyFAKE0").emitData(Buffer.from("hello\r\n"));
  const d1 = await c.data();
  assert.equal(d1.captureId, capture_id);
  assert.equal(d1.slot, port_slot);
  assert.equal(d1.flags & 4, 4);
  assert.equal(d1.seq, 0);
  assert.equal(d1.offset, 0);
  assert.equal(d1.data.toString(), "hello\r\n");

  c.ack(port_slot, capture_id, 7, 1);
  serials.get("ttyFAKE0").emitData(Buffer.from("world\r\n"));
  const d2 = await c.data();
  assert.equal(d2.flags & 4, 4);
  assert.equal(d2.seq, 0);
  assert.equal(d2.offset, 7);
  assert.equal(d2.data.toString(), "world\r\n");

  const info = await c.control("history_info", { port: "ttyFAKE0" });
  assert.equal(info.result.recording, true);
  assert.equal(info.result.capture_id, capture_id);
  assert.equal(info.result.newest.offset, 14);

  c.socket.destroy();
});

test("v1: 断线 resume + linger 过期", async (t) => {
  const { connect, serials } = await setup(t, { captureLingerMs: 300 });
  const c1 = await connect();
  await c1.hello("t1");
  const sub = await c1.control("subscribe", { port: "ttyFAKE0" });
  const { capture_id, port_slot } = sub.result;
  serials.get("ttyFAKE0").emitData(Buffer.from("one\r\n"));
  await c1.data();
  c1.ack(port_slot, capture_id, 5, 1);
  c1.socket.destroy();
  await new Promise((r) => setTimeout(r, 80));

  const c2 = await connect();
  await c2.hello("t1");
  const res = await c2.control("subscribe", {
    port: "ttyFAKE0",
    from: { capture_id, offset: 5 },
  });
  assert.equal(res.ok, true);
  assert.equal(res.result.mode, "resume");
  assert.equal(res.result.start.offset, 5);
  serials.get("ttyFAKE0").emitData(Buffer.from("two\r\n"));
  const d = await c2.data();
  assert.equal(d.offset, 5);
  assert.equal(d.data.toString(), "two\r\n");
  c2.socket.destroy();
  await new Promise((r) => setTimeout(r, 400));

  const c3 = await connect();
  await c3.hello("t1");
  const expired = await c3.control("subscribe", {
    port: "ttyFAKE0",
    from: { capture_id, offset: 9 },
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, "capture_expired");
  c3.socket.destroy();
});

test("v1: 慢/新订阅者 gap", async (t) => {
  const { connect, serials } = await setup(t, { captureMaxBytes: 1024 });
  const c = await connect();
  await c.hello("t1");
  const sub = await c.control("subscribe", { port: "ttyFAKE0" });
  const { capture_id } = sub.result;
  serials
    .get("ttyFAKE0")
    .emitData(Buffer.concat([Buffer.from("x".repeat(900)), Buffer.from("\n")]));
  await c.data();
  serials
    .get("ttyFAKE0")
    .emitData(Buffer.concat([Buffer.from("y".repeat(900)), Buffer.from("\n")]));
  // 第二次数据到达后，capture 超过 1024，最旧条目被淘汰
  const second = await c.data();
  assert.equal(second.flags & 4, 4);
  assert.equal(second.offset, 901);
  const res = await c.control("subscribe", {
    port: "ttyFAKE0",
    from: { capture_id, offset: 0 },
  });
  assert.equal(res.ok, true);
  assert.equal(res.result.mode, "gap");
  assert.ok(res.result.oldest.offset > 0);
  c.socket.destroy();
});

test("v1: 非 writer 不能 WRITE", async (t) => {
  const { connect } = await setup(t);
  const c = await connect();
  await c.hello("t1");
  const s1 = await c.control("subscribe", { port: "ttyFAKE0" });
  assert.equal(s1.result.writer, true);
  const s2 = await c.control("subscribe", { port: "ttyFAKE0" });
  assert.equal(s2.result.writer, false);
  const w = await c.control("write", {
    port: "ttyFAKE0",
    session_id: s2.result.session_id,
    data_b64: Buffer.from("AT\r\n").toString("base64"),
  });
  assert.equal(w.ok, false);
  assert.equal(w.error.code, "not_controller");
  c.socket.destroy();
});

test("v1: token 错误被拒绝", async (t) => {
  const { connect } = await setup(t);
  const c = await connect();
  const f = await (async () => {
    c.send(encodeFrame(T.HELLO, 0, Buffer.from(JSON.stringify({ token: "bad" }))));
    return c.wait(T.ERROR);
  })();
  const err = JSON.parse(f.payload.toString("utf8"));
  assert.equal(err.code, "unauthorized");
});

test("v1: HISTORY_QUERY 分页与 capture 校验", async (t) => {
  const { connect, serials } = await setup(t);
  const c = await connect();
  await c.hello("t1");
  const sub = await c.control("subscribe", { port: "ttyFAKE0" });
  const { capture_id } = sub.result;
  const q1 = await c.control("history_query", { port: "ttyFAKE0", capture_id, limit: 2 });
  assert.equal(q1.ok, false);
  assert.equal(q1.error.code, "unsupported");

  const bad = await c.control("history_query", { port: "ttyFAKE0", capture_id: 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "capture_expired");
  c.socket.destroy();
});

test("非 SH 首帧直接断开", async (t) => {
  const { port } = await setup(t);
  const socket = net.connect(port);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.write('{"op":"HELLO","token":"t1"}\n');
  await closed;
});
