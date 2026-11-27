import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { createHttpServer } from "../src/sdk/http.js";
import { buildServer } from "../src/sdk/server.js";
import { Connection, ConnectionManager } from "../src/connection.js";
import { LogStore } from "../src/log_store.js";
import { LogRouter } from "../src/log_router.js";
import { keyedSerialQueue } from "../src/keyed_queue.js";
import { buildTools } from "../src/tools/index.js";
import { createWebApi } from "../src/web_api.js";

const WEB_DIR = fileURLToPath(new URL("../src/web/", import.meta.url));

function fakePort() {
  const p = new EventEmitter();
  p.path = "/dev/fake-ui";
  p.written = [];
  p.open = (cb) => cb();
  p.close = (cb) => cb();
  p.write = (b, cb) => {
    p.written.push(Buffer.from(b));
    cb(null);
  };
  p.drain = (cb) => cb();
  p.flush = (cb) => cb();
  p.set = (opts, cb) => cb();
  return p;
}

function makeHub() {
  const store = new LogStore({ dir: null });
  const router = new LogRouter(store);
  const manager = new ConnectionManager(router);
  const queue = keyedSerialQueue();
  const tools = buildTools(manager, router, { version: "test" });
  const port = fakePort();
  const conn = new Connection(manager, port, { rx_buffer_size: 1024, newline: "none" }, router);
  manager.connections.set(conn.id, conn);
  return {
    manager,
    tools,
    conn,
    port,
    queue,
    apiHandler: createWebApi({ manager, tools, queue }),
    createServer: () => buildServer({ name: "serial-hub-mcp", version: "test", tools, queue }),
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function sseReader(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return {
    async next() {
      for (;;) {
        const idx = buf.indexOf("\n\n");
        if (idx >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = null;
          const data = [];
          for (const raw of block.split("\n")) {
            if (raw.startsWith("event:")) event = raw.slice(6).trim();
            else if (raw.startsWith("data:")) data.push(raw.slice(5).trim());
          }
          if (!event || !data.length) continue; // 跳过 retry/心跳注释块
          let payload = null;
          if (data.length) {
            try {
              payload = JSON.parse(data.join("\n"));
            } catch (_) {
              payload = null;
            }
          }
          return { event, payload };
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buf += decoder.decode(value, { stream: true });
      }
    },
    async close() {
      try {
        await reader.cancel();
      } catch (_) {}
    },
  };
}

test("Web UI: 静态页、鉴权、连接列表、SSE 与写串口", { timeout: 20000 }, async () => {
  const hub = makeHub();
  const token = "test-token";
  const server = createHttpServer({
    createServer: hub.createServer,
    path: "/mcp",
    token,
    webDir: WEB_DIR,
    apiHandler: hub.apiHandler,
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  let ac = null;
  let reader = null;

  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") || "", /text\/html/);
    assert.match(await page.text(), /serial-hub-mcp/);

    const denied = await fetch(`${base}/api/connections`);
    assert.equal(denied.status, 401);

    const listRes = await fetch(`${base}/api/connections`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.equal(list.ok, true);
    assert.equal(list.response.connections.length, 1);
    assert.equal(list.response.connections[0].connection_id, hub.conn.id);

    ac = new AbortController();
    const stream = await fetch(`${base}/api/stream?connection_id=${hub.conn.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    assert.equal(stream.status, 200);
    reader = sseReader(stream.body);

    const hello = await reader.next();
    assert.equal(hello.event, "hello");
    assert.equal(hello.payload.connection_id, hub.conn.id);

    hub.conn._onData(Buffer.from("hello\n"));
    const data = await reader.next();
    assert.equal(data.event, "data");
    assert.equal(data.payload.dir, "rx");
    assert.equal(data.payload.text, "hello\n");

    const writeRes = await fetch(`${base}/api/write`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        connection_id: hub.conn.id,
        data: "PING",
        encoding: "utf8",
        newline: "none",
      }),
    });
    assert.equal(writeRes.status, 200);
    const written = await writeRes.json();
    assert.equal(written.ok, true);
    assert.equal(hub.port.written.at(-1).toString(), "PING");

    const tx = await reader.next();
    assert.equal(tx.event, "data");
    const txItems = Array.isArray(tx.payload.items) ? tx.payload.items : [tx.payload];
    const txItem = txItems.find((x) => x.dir === "tx");
    assert.equal(txItem.text, "PING");

    const histRes = await fetch(`${base}/api/history?connection_id=${hub.conn.id}&limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(histRes.status, 200);
    const hist = await histRes.json();
    assert.equal(hist.ok, true);
    assert.ok(hist.response.entries.some((e) => e.text.includes("hello")));

    // 0x00 洪水（休眠/悬空口）不再当正文行推，合并成 noise 事件
    hub.conn._onData(Buffer.alloc(2048, 0));
    const noise = await reader.next();
    assert.equal(noise.event, "noise");
    assert.equal(noise.payload.byte, 0);
    assert.ok(noise.payload.bytes >= 2048);

    // 页面上的「关闭标签」：走 /api/close，关掉后连接从列表里消失
    const closeRes = await fetch(`${base}/api/close`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ connection_id: hub.conn.id }),
    });
    assert.equal(closeRes.status, 200);
    const closed = await closeRes.json();
    assert.equal(closed.ok, true);
    assert.equal(closed.response.connection_id, hub.conn.id);
    assert.equal(hub.manager.get(hub.conn.id), null);

    const afterClose = await fetch(`${base}/api/connections`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const afterList = await afterClose.json();
    assert.equal(afterList.response.connections.length, 0);
  } finally {
    if (reader) await reader.close();
    if (ac) ac.abort();
    await closeServer(server);
  }
});
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test("Web UI: xterm 资源、终端流与 /api/input 绕过队列", { timeout: 20000 }, async () => {
  const hub = makeHub();
  const token = "test-token";
  const server = createHttpServer({
    createServer: hub.createServer,
    path: "/mcp",
    token,
    webDir: WEB_DIR,
    apiHandler: hub.apiHandler,
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  let ac = null;
  let reader = null;

  try {
    const xterm = await fetch(`${base}/vendor/xterm.mjs`);
    assert.equal(xterm.status, 200);
    assert.match(xterm.headers.get("content-type") || "", /javascript/);
    assert.ok((await xterm.text()).length > 100000);
    const fit = await fetch(`${base}/vendor/addon-fit.mjs`);
    assert.equal(fit.status, 200);
    assert.match(fit.headers.get("content-type") || "", /javascript/);
    const css = await fetch(`${base}/vendor/xterm.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") || "", /text\/css/);

    ac = new AbortController();
    const stream = await fetch(`${base}/api/terminal?connection_id=${hub.conn.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    assert.equal(stream.status, 200);
    reader = sseReader(stream.body);
    const hello = await reader.next();
    assert.equal(hello.event, "hello");
    hub.conn._onData(Buffer.from("A\x1b[31mB\r\n"));
    const data = await reader.next();
    assert.equal(data.event, "data");
    assert.equal(data.payload.text, "A\x1b[31mB\r\n");

    // 队列被占住时，/api/input 仍应立即返回（交互式打字不能被 receive 卡住）
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const blocker = hub.queue.run(hub.conn.id, () => gate);
    const inputPromise = fetch(`${base}/api/input`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ connection_id: hub.conn.id, data: "Q", encoding: "utf8" }),
    }).then((r) => ({ r }));
    const first = await Promise.race([inputPromise, sleep(600).then(() => ({ timeout: true }))]);
    assert.ok(!first.timeout, "/api/input 不应等待连接队列");
    release();
    const inputRes = await inputPromise;
    assert.equal(inputRes.r.status, 200);
    assert.equal(hub.port.written.at(-1).toString(), "Q");
    await blocker;
  } finally {
    if (reader) await reader.close();
    if (ac) ac.abort();
    await closeServer(server);
  }
});
