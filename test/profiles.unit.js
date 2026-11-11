import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { list, get, put, remove, defaultProfilesFile } from "../src/profiles.js";

test("profile 持久化 put/get/list/remove", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serial_hub_mcp-prof-"));
  const saved = process.env.SERIAL_HUB_MCP_PROFILES_DIR;
  process.env.SERIAL_HUB_MCP_PROFILES_DIR = dir;
  try {
    put("qp", { baud_rate: 1500000, newline: "crlf", prompt: "# " });
    put("u0", { port: "/dev/ttyUSB0", baud_rate: 115200 });
    const qp = get("qp");
    assert.equal(qp.baud_rate, 1500000);
    assert.equal(qp.newline, "crlf");
    assert.deepEqual(
      list()
        .map((p) => p.name)
        .sort(),
      ["qp", "u0"],
    );
    assert.equal(defaultProfilesFile().startsWith(dir), true);
    assert.equal(remove("qp"), true);
    assert.equal(get("qp"), null);
    assert.throws(() => put("", {}));
  } finally {
    if (saved === undefined) delete process.env.SERIAL_HUB_MCP_PROFILES_DIR;
    else process.env.SERIAL_HUB_MCP_PROFILES_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
