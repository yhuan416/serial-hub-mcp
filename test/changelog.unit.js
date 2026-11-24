import { test } from "node:test";
import assert from "node:assert/strict";
import { groupCommits, parseCommit, renderMarkdown } from "../scripts/changelog.mjs";

test("changelog: 解析 Conventional Commits", () => {
  assert.deepEqual(parseCommit("abc1234\x1f2026-11-24\x1ffeat(api): add /info"), {
    hash: "abc1234",
    date: "2026-11-24",
    type: "feat",
    scope: "api",
    breaking: false,
    subject: "add /info",
  });
  assert.equal(parseCommit("deadbee\x1f2026-11-24\x1frandom subject").type, "other");
  const bang = parseCommit("c0ffee1\x1f2026-11-24\x1ffeat!: drop node 16");
  assert.equal(bang.breaking, true);
  assert.equal(bang.subject, "drop node 16");
  assert.equal(parseCommit("f00d\x1f2026-11-24\x1frelease: 0.3.4"), null, "release 提交跳过");
});

test("changelog: 按固定顺序分组并渲染", () => {
  const commits = [
    parseCommit("a1\x1f2026-11-24\x1fdocs: update README"),
    parseCommit("b2\x1f2026-11-24\x1ffeat(info): add page"),
    parseCommit("c3\x1f2026-11-24\x1ffix: handle empty dir"),
    parseCommit("d4\x1f2026-11-24\x1frelease: 0.3.4"),
  ];
  const groups = groupCommits(commits);
  assert.deepEqual(
    groups.map(([type]) => type),
    ["feat", "fix", "docs"],
  );
  const md = renderMarkdown(commits, { range: "v0.3.3..HEAD" });
  assert.match(md, /### 新增/);
  assert.match(md, /- \*\*info\*\*: add page \(b2\)/);
  assert.match(md, /- update README \(a1\)/);
  assert.match(md, /范围 v0\.3\.3\.\.HEAD/);
  assert.ok(!md.includes("release: 0.3.4"));
});
