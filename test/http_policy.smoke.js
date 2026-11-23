import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.js");

function baseEnv() {
  const env = { ...process.env };
  delete env.SERIAL_HUB_MCP_HTTP;
  delete env.SERIAL_HUB_MCP_HTTP_HOST;
  delete env.SERIAL_HUB_MCP_HTTP_PORT;
  delete env.SERIAL_HUB_MCP_HTTP_PATH;
  delete env.SERIAL_HUB_MCP_HTTP_TOKEN;
  delete env.SERIAL_HUB_MCP_HTTP_ALLOW_ANONYMOUS;
  env.SERIAL_HUB_MCP_STORE = "legacy";
  env.SERIAL_HUB_MCP_LOGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shub-http-policy-"));
  env.SERIAL_HUB_MCP_CACHE_TTL_DAYS = "0";
  return env;
}

function cleanup(env) {
  fs.rmSync(env.SERIAL_HUB_MCP_LOGS_DIR, { recursive: true, force: true });
}

function spawnServer(args, env) {
  const child = spawn(process.execPath, [SERVER, "--http", ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal })),
  );
  return { child, closed, stderr: () => stderr };
}

function waitFor(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (pred()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  })();
}

test("HTTP: 非回环地址无 token 拒绝启动", { timeout: 15000 }, async () => {
  const env = baseEnv();
  try {
    const { closed, stderr } = spawnServer(["--host", "0.0.0.0", "--port", "0"], env);
    const { code } = await closed;
    assert.equal(code, 1);
    assert.match(stderr(), /拒绝启动/);
    assert.match(stderr(), /SERIAL_HUB_MCP_HTTP_TOKEN/);
  } finally {
    cleanup(env);
  }
});

test("HTTP: --allow-anonymous 放行非回环无 token", { timeout: 15000 }, async () => {
  const env = baseEnv();
  const { child, closed, stderr } = spawnServer(
    ["--host", "0.0.0.0", "--port", "0", "--allow-anonymous"],
    env,
  );
  try {
    const started = await waitFor(() => stderr().includes("MCP server 启动"), 10000);
    assert.ok(started, `server 未启动：${stderr()}`);
    assert.match(stderr(), /已允许匿名访问/);
  } finally {
    child.kill("SIGTERM");
    await closed;
    cleanup(env);
  }
});
