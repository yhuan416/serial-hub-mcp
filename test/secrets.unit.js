import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSecret } from "../src/secrets.js";

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shub-secret-"));
  const file = path.join(dir, "secret");
  fs.writeFileSync(file, content);
  return { dir, file };
}

test("readSecret: 直接环境变量优先", () => {
  const { dir, file } = tmpFile("from-file\n");
  try {
    assert.equal(
      readSecret("TEST_TOKEN", {
        env: { TEST_TOKEN: "from-env", TEST_TOKEN_FILE: file },
      }),
      "from-env",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readSecret: 读取 *_FILE 并去掉首尾空白", () => {
  const { dir, file } = tmpFile("  from-file\n");
  try {
    assert.equal(readSecret("TEST_TOKEN", { env: { TEST_TOKEN_FILE: file } }), "from-file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readSecret: 空环境变量回落到文件", () => {
  const { dir, file } = tmpFile("from-file\n");
  try {
    assert.equal(
      readSecret("TEST_TOKEN", { env: { TEST_TOKEN: "", TEST_TOKEN_FILE: file } }),
      "from-file",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readSecret: 文件缺失抛错", () => {
  assert.throws(
    () => readSecret("TEST_TOKEN", { env: { TEST_TOKEN_FILE: "/nonexistent/token" } }),
    /无法读取 TEST_TOKEN_FILE/,
  );
});

test("readSecret: 空文件抛错", () => {
  const { dir, file } = tmpFile(" \n");
  try {
    assert.throws(() => readSecret("TEST_TOKEN", { env: { TEST_TOKEN_FILE: file } }), /文件为空/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readSecret: 两个都没设置返回 undefined", () => {
  assert.equal(readSecret("TEST_TOKEN", { env: {} }), undefined);
});
