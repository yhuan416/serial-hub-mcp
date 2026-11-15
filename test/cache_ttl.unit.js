import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepCache } from "../src/cache_ttl.js";

test("超过 TTL 的缓存目录删掉，仍在写的留下", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ttl-"));
  const oldDir = path.join(root, "old-conn");
  const fresh = path.join(root, "fresh.log");
  fs.mkdirSync(oldDir);
  fs.writeFileSync(path.join(oldDir, "part-000000.jsonl"), "old\n");
  fs.writeFileSync(fresh, "new\n");
  const old = Date.now() - 8 * 86400000;
  fs.utimesSync(path.join(oldDir, "part-000000.jsonl"), old / 1000, old / 1000);
  fs.utimesSync(oldDir, old / 1000, old / 1000);

  const result = sweepCache([root], 7);
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(result.removed.length, 1);
});

test("TTL 为 0 时不清理", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ttl0-"));
  const file = path.join(root, "keep.log");
  fs.writeFileSync(file, "x");
  const old = Date.now() - 30 * 86400000;
  fs.utimesSync(file, old / 1000, old / 1000);
  sweepCache([root], 0);
  assert.equal(fs.existsSync(file), true);
});
