import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { allocDumpFile, publishDump, resolveDump, sealDump } from "../src/dump_catalog.js";

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dump-catalog-"));
  const prev = process.env.SERIAL_HUB_MCP_DUMPS_DIR;
  process.env.SERIAL_HUB_MCP_DUMPS_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.SERIAL_HUB_MCP_DUMPS_DIR;
    else process.env.SERIAL_HUB_MCP_DUMPS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("alloc + seal 只给 file_id / 相对路径 / sha256", () => {
  withDir(() => {
    const { file_id, file, download_path } = allocDumpFile("dump");
    fs.writeFileSync(file, "AAA\nBBB\n");
    const sealed = sealDump(file, file_id);
    assert.equal(sealed.file_id, file_id);
    assert.equal(sealed.download_path, download_path);
    assert.equal(sealed.download_path, `/dumps/${file_id}`);
    assert.equal(sealed.bytes, 8);
    assert.equal(sealed.sha256, crypto.createHash("sha256").update("AAA\nBBB\n").digest("hex"));
    assert.equal(sealed.preview, "AAA\nBBB\n");
    assert.equal(sealed.file, undefined);
    assert.equal(sealed.path, undefined);
  });
});

test("publishDump 丢掉容器绝对路径，保留调用方预览", () => {
  withDir(() => {
    const { file_id, file } = allocDumpFile("export");
    fs.writeFileSync(file, "line\n");
    const pub = publishDump(
      { file, path: "/data/secret.log", lines: 1, preview: "keep" },
      file_id,
      file,
    );
    assert.equal(pub.file, undefined);
    assert.equal(pub.path, undefined);
    assert.equal(pub.lines, 1);
    assert.equal(pub.preview, "keep");
    assert.match(pub.download_path, /^\/dumps\/export-/);
    assert.equal(pub.sha256.length, 64);
  });
});

test("resolveDump 拒绝穿越和目录外文件", () => {
  withDir((dir) => {
    const { file_id, file } = allocDumpFile("dump");
    fs.writeFileSync(file, "ok");
    assert.equal(resolveDump(file_id), fs.realpathSync(file));
    assert.equal(resolveDump("../etc/passwd"), null);
    assert.equal(resolveDump(".."), null);
    assert.equal(resolveDump("foo/bar.log"), null);
    assert.equal(resolveDump(""), null);
    assert.equal(resolveDump("missing.log"), null);
    const outside = path.join(dir, "link.log");
    fs.symlinkSync("/etc/passwd", outside);
    assert.equal(resolveDump("link.log"), null);
  });
});
