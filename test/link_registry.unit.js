import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRemoteLink,
  endpointScheme,
  listRemoteSchemes,
  registerRemoteScheme,
  PLANNED_SCHEMES,
} from "../src/links/remote.js";

test("endpointScheme 解析合法/非法 URI", () => {
  assert.equal(endpointScheme("tcp://host:7000"), "tcp");
  assert.equal(endpointScheme("MQTT://broker:1883/t"), "mqtt");
  assert.equal(endpointScheme("not-an-endpoint"), null);
  assert.equal(endpointScheme(null), null);
});

test("tcp 默认已注册", () => {
  assert.ok(listRemoteSchemes().includes("tcp"));
});

test("注册远端 scheme 后，endpoint 能分派到 connector", async () => {
  const seen = [];
  registerRemoteScheme("mock", async (cfg) => {
    seen.push(cfg.endpoint);
    return { rpc: { mock: true }, info: { proto: "v0" } };
  });
  assert.ok(listRemoteSchemes().includes("mock"));

  const link = await createRemoteLink({ endpoint: "mock://bus:1" });
  assert.equal(link.rpc.mock, true);
  assert.equal(link.info.proto, "v0");
  assert.deepEqual(seen, ["mock://bus:1"]);
});

test("未注册的 scheme 报错，并给出规划清单", async () => {
  await assert.rejects(() => createRemoteLink({ endpoint: "kcp://host:7000" }), /尚未实现/);
  assert.ok(PLANNED_SCHEMES.includes("udp"));
  assert.ok(PLANNED_SCHEMES.includes("mqtt"));
  assert.ok(!PLANNED_SCHEMES.includes("tcp"));
});

test("非法 endpoint 直接报错", async () => {
  await assert.rejects(() => createRemoteLink({ endpoint: "host:7000" }), /endpoint 非法/);
});
