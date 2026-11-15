import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordOpen, listOpens } from "../src/open_log.js";

test("open 记录去重、保留名字、换波特率另起一行", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opens-"));
  process.env.SERIAL_HUB_MCP_OPENS_FILE = path.join(dir, "opens.json");
  const status = (port, baud) => ({
    transport: "remote",
    endpoint: "tcp://192.168.4.67:7000",
    port,
    config: { baud_rate: baud, port_id: port, token: "secret" },
  });

  const first = recordOpen(status("uart1", 1500000), "主控");
  const again = recordOpen(status("uart1", 1500000));
  assert.equal(again.open_count, 2);
  assert.equal(again.name, "主控");
  assert.equal(again.first_opened_at, first.first_opened_at);
  assert.equal(JSON.stringify(again).includes("secret"), false);

  recordOpen(status("uart1", 115200), "调试");
  recordOpen(status("uart2", 115200), "二进制");
  assert.equal(
    listOpens({ port: "uart1" })
      .map((r) => r.baud_rate)
      .sort()
      .join(","),
    "115200,1500000",
  );
  assert.equal(listOpens({ name: "二进制" }).length, 1);
});
