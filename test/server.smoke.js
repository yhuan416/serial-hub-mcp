import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCPClient } from "../test-utils/mcp_client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "src", "server.js");

const TOOLS = [
  "list_ports",
  "open",
  "close",
  "write",
  "read",
  "transact",
  "get_status",
  "set_dtr_rts",
  "send_break",
  "receive",
  "dump_to_file",
  "profile_list",
  "profile_save",
  "profile_delete",
  "log_query",
  "log_export",
  "log_stats",
  "log_clear",
  "service_info",
];

test("smoke: 握手 + 工具枚举（19 个）", async () => {
  const client = new MCPClient(process.execPath, [SERVER], { stderr: "pipe" });
  try {
    const sdk = await client.start();
    const { tools } = await sdk.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...TOOLS].sort());
  } finally {
    await client.close();
  }
});

test("smoke: service_info 返回服务名/版本/工具数", async () => {
  const client = new MCPClient(process.execPath, [SERVER], { stderr: "pipe" });
  try {
    await client.start();
    const r = await client.callToolJson("service_info", {});
    assert.equal(r.isError, false);
    const info = r.data.response;
    assert.equal(info.service, "serial-hub-mcp");
    assert.ok(typeof info.version === "string" && info.version.length > 0);
    assert.equal(info.tools_count, 19);
    assert.ok(typeof info.changelog === "string" && info.changelog.includes("0.1.0"));
    assert.ok(info.changelog_path.endsWith("CHANGELOG.md"));
  } finally {
    await client.close();
  }
});

test("smoke: list_ports 返回 ports 数组", async () => {
  const client = new MCPClient(process.execPath, [SERVER], { stderr: "pipe" });
  try {
    await client.start();
    const r = await client.callToolJson("list_ports", {});
    assert.equal(r.data.ok, true);
    assert.equal(Array.isArray(r.data.response.ports), true);
  } finally {
    await client.close();
  }
});

test("smoke: 非法调用 → isError（不提升为 JSON-RPC 错误）", async () => {
  const client = new MCPClient(process.execPath, [SERVER], { stderr: "pipe" });
  try {
    await client.start();
    const r = await client.callToolJson("open", {});
    assert.equal(r.isError, true);
    assert.equal(r.data.ok, false);
  } finally {
    await client.close();
  }
});
