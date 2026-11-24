#!/usr/bin/env node
// 从 git 提交生成 CHANGELOG 草稿（Conventional Commits）。
//
//   npm run changelog             # 上个 tag..HEAD
//   npm run changelog -- v0.3.2   # 指定起点
//
// 输出只是草稿：按类型分组、带短 hash，方便改写成 CHANGELOG.md 里面向用户的条目。
// 不直接写文件——发布说明需要人判断哪些对用户可见。

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// 顺序即输出顺序；`release` 提交是版本噪音，直接跳过。
export const GROUPS = [
  ["feat", "新增"],
  ["fix", "修复"],
  ["perf", "性能"],
  ["refactor", "重构"],
  ["docs", "文档"],
  ["test", "测试"],
  ["ci", "CI"],
  ["build", "构建"],
  ["chore", "维护"],
  ["other", "其他"],
];
const SKIP = new Set(["release"]);

/** @param {string} line 形如 `<hash>\x1f<date>\x1f<subject>` */
export function parseCommit(line) {
  const [hash, date, subject] = String(line).split("\x1f");
  if (!hash || !subject) return null;
  const m = /^([a-zA-Z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject.trim());
  const type = m ? m[1].toLowerCase() : "other";
  if (SKIP.has(type)) return null;
  return {
    hash,
    date: date || null,
    type: GROUPS.some(([t]) => t === type) ? type : "other",
    scope: m?.[2] || null,
    breaking: Boolean(m?.[3]),
    subject: m ? m[4].trim() : subject.trim(),
  };
}

/** @param {Array<ReturnType<typeof parseCommit>>} commits */
export function groupCommits(commits) {
  const buckets = new Map(GROUPS.map(([type]) => [type, []]));
  for (const c of commits) {
    if (!c) continue;
    buckets.get(c.type).push(c);
  }
  return GROUPS.map(([type, label]) => [type, label, buckets.get(type)]).filter(
    ([, , list]) => list.length > 0,
  );
}

export function renderMarkdown(commits, { range } = {}) {
  const groups = groupCommits(commits);
  const lines = [
    `<!-- 由 scripts/changelog.mjs 生成 · 范围 ${range || "HEAD"} · ${commits.length} 个提交 -->`,
    "<!-- 草稿：按用户可见性改写后贴到 CHANGELOG.md 的 Unreleased 下 -->",
    "",
  ];
  if (!groups.length) {
    lines.push("（没有需要记录的提交）");
    return lines.join("\n");
  }
  for (const [, label, list] of groups) {
    lines.push(`### ${label}`, "");
    for (const c of list) {
      const scope = c.scope ? `**${c.scope}**: ` : "";
      const bang = c.breaking ? " **(breaking)**" : "";
      lines.push(`- ${scope}${c.subject}${bang} (${c.hash})`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", cwd: process.cwd() }).trim();
}

export function latestTag() {
  try {
    return git(["describe", "--tags", "--abbrev=0"]);
  } catch (_) {
    return null;
  }
}

export function readCommits(since) {
  const range = since ? `${since}..HEAD` : "HEAD";
  const out = git(["log", range, "--no-merges", "--date=short", "--pretty=format:%h%x1f%ad%x1f%s"]);
  if (!out) return { range, commits: [] };
  return { range, commits: out.split("\n").map(parseCommit).filter(Boolean) };
}

function main(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(
      "用法: npm run changelog [-- <since-ref>]\n默认起点是最近的 tag（git describe --tags --abbrev=0）。\n",
    );
    return;
  }
  const explicit = argv.find((a) => !a.startsWith("-"));
  const since = explicit || latestTag();
  const { range, commits } = readCommits(since);
  process.stdout.write(`${renderMarkdown(commits, { range })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main(process.argv.slice(2));
