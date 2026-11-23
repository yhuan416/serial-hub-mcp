import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHttpServer } from "../src/sdk/http.js";
import { buildServer } from "../src/sdk/server.js";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/mcp", method: "GET", headers },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("HTTP: bad Host/Origin 被 DNS rebinding 保护拒绝", { timeout: 20000 }, async () => {
  const port = await freePort();
  const server = createHttpServer({
    createServer: () => buildServer({ name: "test", version: "0", tools: [] }),
    path: "/mcp",
    allowedHosts: [`127.0.0.1:${port}`],
    allowedOrigins: [`http://127.0.0.1:${port}`],
  });
  await listen(server, port);
  try {
    assert.equal((await request(port, { Host: "evil.example" })).status, 403);
    assert.equal(
      (await request(port, { Host: `127.0.0.1:${port}`, Origin: "http://evil.example" })).status,
      403,
    );
    assert.notEqual((await request(port, { Host: `127.0.0.1:${port}` })).status, 403);
    assert.notEqual(
      (
        await request(port, {
          Host: `127.0.0.1:${port}`,
          Origin: `http://127.0.0.1:${port}`,
        })
      ).status,
      403,
    );
  } finally {
    await close(server);
  }
});
