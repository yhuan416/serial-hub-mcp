import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHttpAllowlist } from "../src/http_allowlist.js";

test("loopback 默认生成 Host/Origin 白名单", () => {
  const r = buildHttpAllowlist({ host: "127.0.0.1", port: 8787, env: {} });
  assert.deepEqual(r.allowedHosts, ["127.0.0.1:8787", "localhost:8787", "[::1]:8787"]);
  assert.deepEqual(r.allowedOrigins, [
    "http://127.0.0.1:8787",
    "http://localhost:8787",
    "http://[::1]:8787",
  ]);
});

test("localhost 默认包含三种 loopback 写法", () => {
  const r = buildHttpAllowlist({ host: "localhost", port: 9000, env: {} });
  assert.deepEqual(r.allowedHosts, ["localhost:9000", "127.0.0.1:9000", "[::1]:9000"]);
});

test("非 loopback 不生成默认白名单", () => {
  const r = buildHttpAllowlist({ host: "0.0.0.0", port: 8787, env: {} });
  assert.equal(r.allowedHosts, undefined);
  assert.equal(r.allowedOrigins, undefined);
});

test("临时端口 0 不生成默认白名单", () => {
  const r = buildHttpAllowlist({ host: "127.0.0.1", port: 0, env: {} });
  assert.equal(r.allowedHosts, undefined);
  assert.equal(r.allowedOrigins, undefined);
});

test("环境变量显式覆盖默认值", () => {
  const r = buildHttpAllowlist({
    host: "127.0.0.1",
    port: 8787,
    env: {
      SERIAL_HUB_MCP_HTTP_ALLOWED_HOSTS: "a.example:8787, b.example:8787",
      SERIAL_HUB_MCP_HTTP_ALLOWED_ORIGINS: "https://a.example",
    },
  });
  assert.deepEqual(r.allowedHosts, ["a.example:8787", "b.example:8787"]);
  assert.deepEqual(r.allowedOrigins, ["https://a.example"]);
});
