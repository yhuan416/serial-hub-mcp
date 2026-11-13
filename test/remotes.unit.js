// remotes.js：配置解析 / 环境变量覆盖 / 名称解析。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadRemotes, resolveRemote } from "../src/remotes.js";

function withEnv(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(patch)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("remotes: 文件解析（token_env/disabled/非法/重复）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shub-remotes-"));
  const file = path.join(dir, "remotes.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      remotes: [
        { name: "lab", endpoint: "tcp://10.0.0.1:7000", token: "abc" },
        { name: "esp32", endpoint: "tcp://10.0.0.2:7000", token_env: "SHUB_TEST_TOKEN" },
        { name: "off", endpoint: "tcp://10.0.0.3:7000", enabled: false },
        { name: "bad", endpoint: "not-a-url" },
        { name: "lab", endpoint: "tcp://10.0.0.4:7000" },
      ],
    }),
  );
  withEnv(
    {
      SERIAL_HUB_MCP_REMOTES: undefined,
      SERIAL_HUB_MCP_REMOTES_FILE: file,
      SHUB_TEST_TOKEN: "envtok",
    },
    () => {
      const cfg = loadRemotes();
      assert.equal(cfg.file, file);
      assert.deepEqual(
        cfg.remotes.map((r) => r.name),
        ["lab", "esp32"],
      );
      assert.equal(cfg.remotes[0].token, "abc");
      assert.equal(cfg.remotes[1].token, "envtok");
      assert.ok(cfg.warnings.length >= 2);
      assert.equal(resolveRemote("esp32").endpoint, "tcp://10.0.0.2:7000");
      assert.throws(() => resolveRemote("nope"), /remote 不存在/);
    },
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("remotes: 环境变量 JSON 覆盖文件", () => {
  withEnv(
    {
      SERIAL_HUB_MCP_REMOTES: JSON.stringify([
        { name: "inline", endpoint: "tcp://127.0.0.1:7001", token: "t" },
      ]),
      SERIAL_HUB_MCP_REMOTES_FILE: "/nonexistent/remotes.json",
    },
    () => {
      const cfg = loadRemotes();
      assert.equal(cfg.fromEnv, true);
      assert.equal(cfg.remotes.length, 1);
      assert.equal(cfg.remotes[0].name, "inline");
      assert.equal(cfg.remotes[0].timeout_ms, 15000);
    },
  );
});
