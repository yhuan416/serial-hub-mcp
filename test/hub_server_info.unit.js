// serial-hub-server 的 HTTP 自描述：与二进制 SH 帧共用 7000 端口，按首字节嗅探。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../src/hub-server/server.js";

async function setup(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shub-info-"));
  const server = new HubServer({
    dataDir: dir,
    token: "hub-secret-token",
    tokenSource: "SERIAL_HUB_SERVER_TOKEN",
    fwVersion: "9.9.9",
    listPorts: async () => [{ path: "/dev/ttyFAKE0" }],
    serialFactory: () => {
      throw new Error("not used");
    },
    scanIntervalMs: 600000,
    ...opts,
  });
  const addr = await server.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { server, port: addr.port, dir };
}

function httpGet(port, pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      const lines = [
        `GET ${pathName} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        "Connection: close",
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    });
    const chunks = [];
    socket.on("data", (c) => chunks.push(c));
    socket.on("error", reject);
    socket.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const idx = raw.indexOf("\r\n\r\n");
      const head = raw.slice(0, idx);
      resolve({ head, body: raw.slice(idx + 4), status: Number(head.split(" ")[1]) });
    });
  });
}

test("hub /info：JSON 自描述，含部署/存储/限制/端点/接入", async (t) => {
  const { port, dir } = await setup(t);
  const { status, head, body } = await httpGet(port, "/info");
  assert.equal(status, 200);
  assert.match(head, /content-type: application\/json/);
  const info = JSON.parse(body);
  assert.equal(info.service, "serial-hub-server");
  assert.equal(info.version, "9.9.9");
  assert.equal(info.deployment.runtime.startsWith("node "), true);
  assert.equal(info.deployment.listen.endsWith(`:${port}`), true);
  assert.equal(info.deployment.ports, 1);
  assert.equal(info.deployment.portIds, "ttyFAKE0");
  assert.equal(info.deployment.tokenSource, "环境变量 SERIAL_HUB_SERVER_TOKEN");
  assert.equal(info.storage.dataDir, dir);
  assert.ok(info.limits.ringBytes.includes("MiB"));
  assert.equal(info.endpoints.info.path, "/info");
  assert.equal(info.endpoints.tcp.path, `127.0.0.1:${port}`);
  assert.ok(info.integration.snippets.some((s) => s.code.includes("remotes")));
  assert.ok(info.integration.snippets.some((s) => s.title.includes("serial-hub_open")));
  assert.equal(info.ports.length, 1);
  // 页面免鉴权，且不能带 token
  assert.equal(JSON.stringify(info).includes("hub-secret-token"), false);
});

test("hub /info：?format=html 与 Accept 协商返回可读页", async (t) => {
  const { port } = await setup(t);
  const byParam = await httpGet(port, "/info?format=html");
  assert.equal(byParam.status, 200);
  assert.match(byParam.head, /content-type: text\/html/);
  assert.ok(byParam.body.includes("部署"));
  assert.ok(byParam.body.includes("接入步骤"));
  assert.ok(byParam.body.includes('href="?format=json"'));

  const byAccept = await httpGet(port, "/info", { Accept: "text/html,application/xhtml+xml" });
  assert.match(byAccept.head, /content-type: text\/html/);

  // 浏览器访问根路径也给同一个页面
  const root = await httpGet(port, "/");
  assert.match(root.head, /content-type: text\/html/);
});

test("hub /health：HTTP 健康检查与 404/405", async (t) => {
  const { port } = await setup(t);
  const health = await httpGet(port, "/health");
  assert.equal(health.status, 200);
  const data = JSON.parse(health.body);
  assert.equal(data.ok, true);
  assert.equal(data.transport, "tcp");
  assert.equal(data.ports, 1);

  const missing = await httpGet(port, "/nope");
  assert.equal(missing.status, 404);

  const post = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.write("POST /info HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\nhi");
    });
    const chunks = [];
    socket.on("data", (c) => chunks.push(c));
    socket.on("error", reject);
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  assert.match(post, /^HTTP\/1\.1 405/);
});

test("hub：PUBLIC_URL 覆盖显示地址，二进制帧仍然可用", async (t) => {
  const prev = process.env.SERIAL_HUB_SERVER_PUBLIC_URL;
  process.env.SERIAL_HUB_SERVER_PUBLIC_URL = "http://serial-hub.lan:7000/";
  t.after(() => {
    if (prev === undefined) delete process.env.SERIAL_HUB_SERVER_PUBLIC_URL;
    else process.env.SERIAL_HUB_SERVER_PUBLIC_URL = prev;
  });
  const { port } = await setup(t);
  const { body } = await httpGet(port, "/info");
  const info = JSON.parse(body);
  assert.equal(info.deployment.publicUrl, "http://serial-hub.lan:7000");

  // 非 SH 首字节仍直接断开（保持原有行为）
  const closed = await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () =>
      socket.write(Buffer.from("XX")),
    );
    socket.on("close", () => resolve(true));
    socket.on("error", () => resolve(true));
  });
  assert.equal(closed, true);
});
