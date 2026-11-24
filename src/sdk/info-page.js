// /info 的统一表示：同一份数据给脚本（JSON）和人（HTML）。
//
// 约定（详见 docs/info-page.md）：
//   1. 同一路径按 `?format=html|json` 或 `Accept` 协商两种表示，默认 JSON；
//   2. 页面免鉴权，且永远不包含 token / 密钥；
//   3. HTTP 的 /info 与 MCP 的 `service_info` 工具同源，字段一致。
//
// 页面骨架固定五段：部署 / 存储 / 限制 / 端点 / 接入步骤（外加可选变更摘要）。
// 新增服务时只需要按这个形状拼数据，渲染交给 renderInfoHtml()。

import fs from "node:fs";
import path from "node:path";

const FORMATS = new Set(["json", "html"]);

// JSON 用英文键（脚本友好），页面显示中文标签。缺少映射时原样显示键名。
const DEFAULT_LABELS = {
  runtime: "运行时",
  platform: "平台",
  transport: "传输",
  publicUrl: "访问地址",
  listen: "监听",
  startedAt: "启动时间",
  uptimeSeconds: "已运行（秒）",
  image: "镜像",
  nodeEnv: "NODE_ENV",
  ui: "Web UI",
  auth: "鉴权",
  mode: "存储模式",
  localStore: "本地连接存储",
  localStoreSize: "本地存储大小",
  remoteStore: "远端缓存存储",
  remoteStoreSize: "远端缓存大小",
  dumps: "dump 目录",
  dumpsSize: "dump 大小",
  syncDir: "remote-sync 缓存",
  v1Cache: "v1 缓存",
  profiles: "profiles 目录",
  opens: "opens 索引",
  dataDir: "数据目录",
  dataDirSize: "数据目录大小",
  tokenSource: "token 来源",
  retainBytes: "每连接保留上限",
  retentionBytes: "磁盘保留上限",
  retentionDays: "保留天数",
  segmentBytes: "单段大小",
  blockBytes: "block 索引粒度",
  flushMs: "落盘间隔",
  cacheTtlDays: "缓存保留天数",
  bodyBytes: "单次请求体",
  tools: "工具数",
  remotes: "远端注册数",
  remoteNames: "远端名称",
  ports: "串口数",
  portIds: "串口",
  portFilter: "端口过滤",
  ringBytes: "每端口环形缓冲",
  ramEntries: "行窗口条数",
  maxFrame: "单帧上限",
  maxHoldMs: "READ 长轮询上限",
  leaseMs: "会话租约",
  captureMaxBytes: "发送缓存上限",
  captureLingerMs: "capture 保留时间",
  windowBytes: "默认窗口",
  maxWindowBytes: "窗口上限",
  scanIntervalMs: "端口扫描周期",
  baudMax: "最高波特率",
  anonymousAllowed: "允许匿名",
  bearerRequired: "需要 Bearer token",
};

/**
 * 选择表示格式：`?format=` 优先；否则按 Accept 头判断（浏览器 → html，curl/脚本 → json）。
 * @param {{headers?: Record<string, string|string[]|undefined>}} req
 * @param {URL} url
 * @returns {"json"|"html"}
 */
export function negotiateInfoFormat(req, url) {
  const explicit = url?.searchParams?.get("format");
  if (explicit) {
    const f = explicit.trim().toLowerCase();
    if (FORMATS.has(f)) return f;
  }
  const raw = req?.headers?.accept;
  const accept = Array.isArray(raw) ? raw.join(",") : String(raw || "");
  const htmlAt = accept.indexOf("text/html");
  if (htmlAt < 0) return "json";
  const jsonAt = accept.indexOf("application/json");
  // `text/html,application/xhtml+xml,...` → html；两类都列时按出现顺序取权重更高的那个。
  if (jsonAt < 0 || htmlAt < jsonAt) return "html";
  return "json";
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 人类可读的字节数（用于存储/限额展示）。 */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return String(n ?? "—");
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  const shown = i === 0 ? String(x) : x >= 100 ? x.toFixed(0) : x.toFixed(1);
  return `${shown} ${units[i]}`;
}

/**
 * 目录的轻量统计：只统计直接子项的常规文件，不递归、条目上限防大目录拖慢页面。
 * 拿不到目录（不存在/无权限）时返回 null，页面不因此报错。
 * @param {string|null|undefined} dir
 * @param {{maxEntries?: number}} [opts]
 * @returns {{path: string, entries: number, files: number, sizeBytes: number, truncated: boolean}|null}
 */
export function dirStats(dir, opts = {}) {
  if (!dir) return null;
  const maxEntries = Math.max(1, Number(opts.maxEntries) || 5000);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return null;
  }
  const truncated = names.length > maxEntries;
  let files = 0;
  let sizeBytes = 0;
  for (const name of names.slice(0, maxEntries)) {
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      files += 1;
      sizeBytes += st.size;
    } catch (_) {
      /* 并发删除等，忽略单个文件 */
    }
  }
  return { path: dir, entries: names.length, files, sizeBytes, truncated };
}

function cellText(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.length ? value.map((v) => cellText(v)).join("、") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function labelOf(labels, key, sub) {
  const map = { ...DEFAULT_LABELS, ...(labels || {}) };
  if (sub !== undefined) return map[`${key}.${sub}`] || `${map[key] || key}.${sub}`;
  return map[key] || key;
}

function renderRows(rows, labels) {
  const out = [];
  for (const [key, value] of Object.entries(rows || {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      // 一层嵌套：展开成「key.sub」行，避免把整块 JSON 塞进单元格。
      for (const [sub, subValue] of Object.entries(value)) {
        if (subValue === null || subValue === undefined) continue;
        out.push(
          `<tr><th>${escapeHtml(labelOf(labels, key, sub))}</th><td>${escapeHtml(cellText(subValue))}</td></tr>`,
        );
      }
      continue;
    }
    out.push(
      `<tr><th>${escapeHtml(labelOf(labels, key))}</th><td>${escapeHtml(cellText(value))}</td></tr>`,
    );
  }
  return out.join("");
}

function renderSection(title, rows, labels) {
  const body = renderRows(rows, labels);
  if (!body) return "";
  return `<section><h2>${escapeHtml(title)}</h2><table>${body}</table></section>`;
}

function renderEndpoints(endpoints) {
  if (!endpoints || !Object.keys(endpoints).length) return "";
  const rows = Object.entries(endpoints).map(([name, spec]) => {
    if (typeof spec === "string") {
      return `<tr><th>${escapeHtml(name)}</th><td><code>${escapeHtml(spec)}</code></td></tr>`;
    }
    const path = spec?.path ?? spec?.url ?? "";
    const auth = spec?.auth ? ` <span class="tag">${escapeHtml(spec.auth)}</span>` : "";
    const desc = spec?.desc ? ` — ${escapeHtml(spec.desc)}` : "";
    return `<tr><th>${escapeHtml(name)}</th><td><code>${escapeHtml(path)}</code>${auth}${desc}</td></tr>`;
  });
  return `<section><h2>端点</h2><table>${rows.join("")}</table></section>`;
}

function renderIntegration(integration) {
  if (!integration) return "";
  const parts = [];
  if (integration.hint) parts.push(`<p class="sub">${escapeHtml(integration.hint)}</p>`);
  const snippets = Array.isArray(integration.snippets)
    ? integration.snippets
    : integration.code
      ? [{ title: integration.title, code: integration.code }]
      : [];
  for (const s of snippets) {
    if (!s || (!s.code && !s.text)) continue;
    if (s.title) parts.push(`<p class="sub">${escapeHtml(s.title)}</p>`);
    parts.push(`<pre>${escapeHtml(s.code ?? s.text)}</pre>`);
  }
  if (!parts.length) return "";
  return `<section><h2>接入步骤</h2>${parts.join("")}</section>`;
}

function renderChangelog(info) {
  const text = typeof info.changelog === "string" ? info.changelog.trim() : "";
  if (!text) return "";
  return (
    `<section><h2>变更摘要</h2><details><summary>CHANGELOG（最近若干行）</summary>` +
    `<pre>${escapeHtml(text)}</pre></details></section>`
  );
}

/**
 * 渲染自描述页面。字段全部来自 info，缺哪段就不渲染哪段。
 * @param {object} info 与 /info JSON 相同的数据
 * @returns {string} 完整 HTML（自包含，无外部资源）
 */
export function renderInfoHtml(info = {}) {
  const service = info.service || "service";
  const version = info.version || "unknown";
  const summary = info.summary ? escapeHtml(info.summary) : "";
  const uptimeSeconds = Number(info.deployment?.uptimeSeconds);
  const uptime =
    Number.isFinite(uptimeSeconds) && uptimeSeconds >= 0
      ? `运行 ${formatUptime(uptimeSeconds)}`
      : "";
  const subtitle = [summary, uptime].filter(Boolean).join(" · ");
  const publicUrl = info.deployment?.publicUrl
    ? `<a href="${escapeHtml(info.deployment.publicUrl)}">${escapeHtml(info.deployment.publicUrl)}</a>`
    : "";

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(service)} ${escapeHtml(version)} · 部署信息</title>
<link rel="alternate" type="application/json" href="?format=json">
<style>
:root{color-scheme:light dark}
body{font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:32px;background:#fafafa;color:#18181b}
h1{font-size:20px;margin:0 0 4px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#71717a;margin:24px 0 8px}
.sub{color:#71717a;margin:0 0 8px}
table{border-collapse:collapse;width:100%;max-width:760px;background:#fff;border:1px solid #e4e4e7;border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:7px 12px;border-top:1px solid #f4f4f5;vertical-align:top}
th{width:190px;color:#52525b;font-weight:500}td{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
code{background:#f4f4f5;padding:1px 5px;border-radius:4px}
.tag{background:#eef2ff;color:#3730a3;border-radius:4px;padding:0 5px;font-size:11px}
pre{background:#18181b;color:#e4e4e7;padding:14px;border-radius:8px;overflow:auto;max-width:760px;font-size:12px}
footer{margin-top:24px;color:#71717a;font-size:12px}
@media (prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}table{background:#18181b;border-color:#27272a}th,td{border-color:#27272a}th{color:#a1a1aa}code{background:#27272a}.tag{background:#312e81;color:#c7d2fe}}
</style></head><body>
<h1>${escapeHtml(service)} <span style="color:#71717a">${escapeHtml(version)}</span></h1>
${subtitle ? `<p class="sub">${subtitle}</p>` : ""}
${renderSection("部署", info.deployment, info.labels)}
${renderSection("存储", info.storage, info.labels)}
${renderSection("限制", info.limits, info.labels)}
${renderEndpoints(info.endpoints)}
${renderIntegration(info.integration)}
${renderChangelog(info)}
<footer>${publicUrl ? `访问地址 ${publicUrl} · ` : ""}<a href="?format=json">JSON</a> · 本页免鉴权，不含密钥</footer>
</body></html>`;
}

/** 未指定 PUBLIC_URL 时用请求的 Host 头拼访问地址（容器 hostname 对人无意义）。 */
export function resolvePublicUrl({ envUrl, req, fallback } = {}) {
  const explicit = String(envUrl || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const rawHost = req?.headers?.host;
  const host = Array.isArray(rawHost) ? rawHost[0] : rawHost;
  if (host && /^[A-Za-z0-9.\-:[\]]{1,255}$/.test(host)) {
    const rawProto = req?.headers?.["x-forwarded-proto"];
    const proto = String(Array.isArray(rawProto) ? rawProto[0] : rawProto || "")
      .split(",")[0]
      .trim()
      .toLowerCase();
    return `${proto === "https" ? "https" : "http"}://${host}`;
  }
  const fb = String(fallback || "").trim();
  return fb ? fb.replace(/\/+$/, "") : null;
}

export function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
