import { test } from "node:test";
import assert from "node:assert/strict";
import { CaptureCache } from "../src/remote/v1_connection.js";

test("CaptureCache: 跨 chunk 切行与 offset", () => {
  const c = new CaptureCache({});
  c.addBatch(100, 1000, Buffer.from("ab"));
  c.addBatch(102, 1001, Buffer.from("c\nde\nf"));
  assert.deepEqual(
    c.entries.map((e) => [e.seq, e.offset, e.bytes.toString()]),
    [
      [1, 100, "abc\n"],
      [2, 104, "de\n"],
    ],
  );
  assert.equal(c.partial.toString(), "f");
  assert.equal(c.partialOffset, 107);
  assert.equal(c.bytesIn, 8);
});

test("CaptureCache: 没有换行的流不会让 partial 无限增长", () => {
  const c = new CaptureCache({ maxPartialBytes: 4096 });
  const chunk = Buffer.alloc(1024, 0x41);
  for (let i = 0; i < 50; i += 1) c.addBatch(i * chunk.length, 1000 + i, chunk);
  assert.ok(c.entries.length > 0);
  assert.ok(c.partial.length <= 4096, `partial=${c.partial.length}`);
  assert.equal(c.bytesIn, 50 * 1024);
});

test("CaptureCache: 超上限按批裁剪，条目数有界", () => {
  const c = new CaptureCache({ maxEntries: 1000 });
  const lines = Buffer.from("x\n".repeat(5000));
  c.addBatch(0, 1000, lines);
  assert.ok(c.entries.length <= 1000, `entries=${c.entries.length}`);
  assert.equal(c.entries.at(-1).seq, 5000);
  c.addBatch(lines.length, 1001, Buffer.from("y\n"));
  assert.ok(c.entries.length <= 1000, `entries=${c.entries.length}`);
  assert.equal(c.entries.at(-1).seq, 5001);
  assert.equal(c.entries.at(-1).bytes.toString(), "y\n");
});
