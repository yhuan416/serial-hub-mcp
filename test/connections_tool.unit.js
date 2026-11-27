import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { connTools } from "../src/tools/conn.js";
import { invokeTool } from "../src/sdk/tool.js";

const OPENS_FILE = path.join(os.tmpdir(), `serial-hub-opens-${process.pid}.json`);

function status(over = {}) {
  return {
    connection_id: "c1",
    transport: "remote",
    endpoint: "tcp://hub:7000",
    port: "ttyACM0",
    open: true,
    config: {
      transport: "remote",
      endpoint: "tcp://hub:7000",
      port_id: "ttyACM0",
      baud_rate: 115200,
      data_bits: 8,
      stop_bits: 1,
      parity: "none",
      flow_control: "none",
    },
    bytes_in: 0,
    bytes_out: 0,
    rx_buffered: 0,
    rx_dropped: 0,
    opened_at: Date.now() - 3600_000,
    last_rx_at: null,
    last_tx_at: null,
    idle_ms: 3600_000,
    ...over,
  };
}

function byName(manager) {
  return new Map(connTools(manager).map((t) => [t.name, t]));
}

test("list_connections: 排序、过滤与字段", async () => {
  const manager = {
    list: () => [
      status({ connection_id: "fresh", idle_ms: 0, port: "uart2" }),
      status({
        connection_id: "stale",
        idle_ms: 600_000,
        port: "ttyACM1",
        last_rx_at: Date.now() - 600_000,
        bytes_in: 1234,
      }),
      status({ connection_id: "serial", transport: "serial", endpoint: null, idle_ms: 60_000 }),
    ],
  };
  const tools = byName(manager);

  const all = await invokeTool(tools.get("list_connections"), {}, null);
  assert.equal(all.response.count, 3);
  assert.deepEqual(
    all.response.connections.map((c) => c.connection_id),
    ["stale", "serial", "fresh"],
  );

  const remote = await invokeTool(tools.get("list_connections"), { transport: "remote" }, null);
  assert.equal(remote.response.count, 2);

  const byPort = await invokeTool(tools.get("list_connections"), { port: "UART2" }, null);
  assert.deepEqual(
    byPort.response.connections.map((c) => c.connection_id),
    ["fresh"],
  );

  const stale = await invokeTool(tools.get("list_connections"), { idle_minutes: 5 }, null);
  assert.deepEqual(
    stale.response.connections.map((c) => c.connection_id),
    ["stale"],
  );
});

test("open: 同参数连接已存在时回传 duplicate_of", async () => {
  process.env.SERIAL_HUB_MCP_OPENS_FILE = OPENS_FILE;
  const existing = status({ connection_id: "old", bytes_in: 42, bytes_out: 7 });
  const manager = {
    list: () => [existing],
    open: async (cfg) => ({
      ...status({ connection_id: "new", idle_ms: 0, opened_at: Date.now() }),
      config: cfg,
    }),
  };
  const tools = byName(manager);
  const res = await invokeTool(
    tools.get("open"),
    { transport: "remote", endpoint: "tcp://hub:7000", port_id: "ttyACM0", baud_rate: 115200 },
    null,
  );
  assert.equal(res.response.connection_id, "new");
  assert.equal(res.response.duplicate_of.length, 1);
  assert.equal(res.response.duplicate_of[0].connection_id, "old");
  assert.equal(res.response.duplicate_of[0].bytes_in, 42);
  assert.match(res.response.hint, /复用/);
});

test("open: 打开失败时把已有连接 ID 带进错误", async () => {
  process.env.SERIAL_HUB_MCP_OPENS_FILE = OPENS_FILE;
  const existing = status({ connection_id: "old" });
  const manager = {
    list: () => [existing],
    open: async () => {
      throw new Error("Error: Resource temporarily unavailable");
    },
  };
  const tools = byName(manager);
  await assert.rejects(
    invokeTool(
      tools.get("open"),
      { transport: "remote", endpoint: "tcp://hub:7000", port_id: "ttyACM0", baud_rate: 115200 },
      null,
    ),
    /old/,
  );
});

test("open: 没有同参数连接时不多加字段", async () => {
  process.env.SERIAL_HUB_MCP_OPENS_FILE = OPENS_FILE;
  const manager = {
    list: () => [status({ connection_id: "other", config: { baud_rate: 921600 } })],
    open: async (cfg) => ({ ...status({ connection_id: "new" }), config: cfg }),
  };
  const tools = byName(manager);
  const res = await invokeTool(
    tools.get("open"),
    { transport: "remote", endpoint: "tcp://hub:7000", port_id: "ttyACM0", baud_rate: 115200 },
    null,
  );
  assert.equal(res.response.duplicate_of, undefined);
  assert.equal(res.response.hint, undefined);
});

function reusable(statusObj, calls = []) {
  return {
    id: statusObj.connection_id,
    seekToEnd() {
      calls.push("seek");
    },
    status: () => ({ ...statusObj }),
  };
}

test("open: reuse:true 复用已有连接并默认把游标移到最新", async () => {
  process.env.SERIAL_HUB_MCP_OPENS_FILE = OPENS_FILE;
  const calls = [];
  const old = status({ connection_id: "old", writer: true, bytes_in: 99 });
  const manager = {
    list: () => [old],
    get: (id) => (id === "old" ? reusable(old, calls) : null),
    open: async () => {
      calls.push("open");
      return status({ connection_id: "new" });
    },
  };
  const tools = byName(manager);
  const res = await invokeTool(
    tools.get("open"),
    {
      transport: "remote",
      endpoint: "tcp://hub:7000",
      port_id: "ttyACM0",
      baud_rate: 115200,
      reuse: true,
    },
    null,
  );
  assert.equal(res.response.connection_id, "old");
  assert.equal(res.response.reused, true);
  assert.equal(res.response.reuse_cursor, "tail");
  assert.equal(res.response.bytes_in, 99);
  assert.ok(calls.includes("seek"));
  assert.equal(calls.includes("open"), false);
});

test("open: reuse_cursor:keep 不动游标", async () => {
  process.env.SERIAL_HUB_MCP_OPENS_FILE = OPENS_FILE;
  const calls = [];
  const old = status({ connection_id: "old", writer: true });
  const manager = {
    list: () => [old],
    get: () => reusable(old, calls),
    open: async () => status({ connection_id: "new" }),
  };
  const tools = byName(manager);
  const res = await invokeTool(
    tools.get("open"),
    {
      transport: "remote",
      endpoint: "tcp://hub:7000",
      port_id: "ttyACM0",
      baud_rate: 115200,
      reuse: true,
      reuse_cursor: "keep",
    },
    null,
  );
  assert.equal(res.response.reused, true);
  assert.equal(res.response.reuse_cursor, "keep");
  assert.deepEqual(calls, []);
});

test("open: reuse 只读连接 + claim_writer 明确报错", async () => {
  process.env.SERIAL_HUB_MCP_OPENS_FILE = OPENS_FILE;
  const old = status({ connection_id: "old", writer: false });
  const manager = {
    list: () => [old],
    get: () => reusable(old),
    open: async () => status({ connection_id: "new" }),
  };
  const tools = byName(manager);
  await assert.rejects(
    invokeTool(
      tools.get("open"),
      {
        transport: "remote",
        endpoint: "tcp://hub:7000",
        port_id: "ttyACM0",
        baud_rate: 115200,
        reuse: true,
        claim_writer: true,
      },
      null,
    ),
    /只读连接/,
  );
});

test("open: reuse:true 但没有同参数连接时正常新开", async () => {
  process.env.SERIAL_HUB_MCP_OPENS_FILE = OPENS_FILE;
  let opened = 0;
  const manager = {
    list: () => [status({ connection_id: "other", config: { baud_rate: 921600 } })],
    get: () => null,
    open: async (cfg) => {
      opened += 1;
      return { ...status({ connection_id: "new" }), config: cfg };
    },
  };
  const tools = byName(manager);
  const res = await invokeTool(
    tools.get("open"),
    {
      transport: "remote",
      endpoint: "tcp://hub:7000",
      port_id: "ttyACM0",
      baud_rate: 115200,
      reuse: true,
    },
    null,
  );
  assert.equal(opened, 1);
  assert.equal(res.response.connection_id, "new");
  assert.equal(res.response.reused, undefined);
});
