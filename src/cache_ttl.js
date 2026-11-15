import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// MCP 侧缓存的时间淘汰。日志、v1 捕获、dump 暂存、remote-sync 都算缓存。
// 要长期留下的日志应 dump 到 agent 本机。opens / cursors / profiles 不在这里。

const DAY_MS = 86400000;
const SWEEP_MS = 6 * 60 * 60 * 1000;

export function cacheTtlDays() {
  const raw = process.env.SERIAL_HUB_MCP_CACHE_TTL_DAYS;
  if (raw === undefined || raw === "") return 7;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

export function defaultCacheDirs() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const root = path.join(base, "serial-hub-mcp");
  return [
    process.env.SERIAL_HUB_MCP_LOGS_DIR || path.join(root, "logs"),
    process.env.SERIAL_HUB_MCP_V1_CACHE_DIR || path.join(root, "v1-cache"),
    process.env.SERIAL_HUB_MCP_DUMPS_DIR || path.join(root, "dumps"),
    process.env.SERIAL_HUB_MCP_SYNC_DIR || path.join(root, "remote-sync"),
  ];
}

function newestMtime(p, depth = 0) {
  if (depth > 8) return 0;
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (_) {
    return 0;
  }
  if (st.isSymbolicLink()) return st.mtimeMs;
  let newest = st.mtimeMs;
  if (!st.isDirectory()) return newest;
  let names = [];
  try {
    names = fs.readdirSync(p);
  } catch (_) {
    return newest;
  }
  for (const name of names) {
    newest = Math.max(newest, newestMtime(path.join(p, name), depth + 1));
  }
  return newest;
}

export function sweepCache(dirs = defaultCacheDirs(), days = cacheTtlDays(), now = Date.now()) {
  if (!(days > 0)) return { days, removed: [] };
  const cutoff = now - days * DAY_MS;
  const removed = [];
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      continue;
    }
    for (const name of names) {
      const p = path.join(dir, name);
      if (newestMtime(p) >= cutoff) continue;
      try {
        fs.rmSync(p, { recursive: true, force: true });
        removed.push(p);
      } catch (_) {}
    }
  }
  return { days, removed };
}

export function startCacheSweep(opts = {}) {
  const days = opts.days ?? cacheTtlDays();
  const dirs = opts.dirs ?? defaultCacheDirs();
  const run = () => sweepCache(dirs, days);
  run();
  const timer = setInterval(run, opts.intervalMs ?? SWEEP_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer), days, dirs };
}
