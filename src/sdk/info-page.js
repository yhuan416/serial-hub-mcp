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
  uptimeSeconds: "已运行",
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
  blockBytes: "块索引粒度（block）",
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

function formatStartedAt(value) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(String(value));
  return m ? `${m[1]} ${m[2]} UTC` : String(value);
}

/** 已知字段的人性化显示（只影响页面，JSON 不动）。 */
function formatValue(key, value) {
  // 约定：*Bytes 用字节数、*Ms 用毫秒、*Days 用天数，渲染层补单位；服务给字符串时原样展示。
  if (typeof value === "number" && Number.isFinite(value)) {
    if (key === "uptimeSeconds") return `${formatUptime(value)}（${value} 秒）`;
    if (/Bytes$/.test(key)) return formatBytes(value);
    if (/Ms$/.test(key)) return `${value} ms`;
    if (/Days$/.test(key)) return `${value} 天`;
    if (key === "baudMax") return `${value.toLocaleString("en-US")} baud`;
  }
  if (key === "startedAt") return formatStartedAt(value);
  return cellText(value);
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
          `<tr><th scope="row">${escapeHtml(labelOf(labels, key, sub))}</th><td>${escapeHtml(formatValue(sub, subValue))}</td></tr>`,
        );
      }
      continue;
    }
    out.push(
      `<tr><th scope="row">${escapeHtml(labelOf(labels, key))}</th><td>${escapeHtml(formatValue(key, value))}</td></tr>`,
    );
  }
  return out.join("");
}

function renderSection(id, title, rows, labels) {
  const body = renderRows(rows, labels);
  if (!body) return "";
  return `<section id="${id}"><h2>${escapeHtml(title)}</h2><table>${body}</table></section>`;
}

function copyButton(text, label = "复制") {
  if (!text) return "";
  return ` <button class="copy" type="button" data-copy="${escapeHtml(text)}">${escapeHtml(label)}</button>`;
}

function renderEndpoints(endpoints, baseUrl) {
  if (!endpoints || !Object.keys(endpoints).length) return "";
  const rows = Object.entries(endpoints).map(([name, spec]) => {
    if (typeof spec === "string") {
      return `<tr><th scope="row">${escapeHtml(name)}</th><td><code>${escapeHtml(spec)}</code></td></tr>`;
    }
    const path = spec?.path ?? spec?.url ?? "";
    const authText = spec?.auth || "";
    const free = authText.includes("免鉴权") && !authText.includes("需");
    const tagCls = free ? "tag ok" : authText.includes("Bearer") ? "tag warn" : "tag";
    const auth = authText ? ` <span class="${tagCls}">${escapeHtml(authText)}</span>` : "";
    const desc = spec?.desc ? ` — ${escapeHtml(spec.desc)}` : "";
    const code = escapeHtml(path);
    // 免鉴权的 GET 端点可以直接点开；POST 端点（/mcp）点了只会 405，不做链接。
    const linked =
      free && path.startsWith("/")
        ? `<a href="${escapeHtml(path)}"><code>${code}</code></a>`
        : `<code>${code}</code>`;
    const copy = path.startsWith("/") ? copyButton(`${baseUrl || ""}${path}`, "复制 URL") : "";
    return `<tr><th scope="row">${escapeHtml(name)}</th><td>${linked}${copy}${auth}${desc}</td></tr>`;
  });
  return `<section id="endpoints"><h2>端点</h2><table>${rows.join("")}</table></section>`;
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
    const code = s.code ?? s.text;
    parts.push(
      `<div class="snippet"><div class="snip-head"><span>${escapeHtml(s.title || "配置")}</span>${copyButton(code)}</div>` +
        `<pre>${escapeHtml(code)}</pre></div>`,
    );
  }
  if (!parts.length) return "";
  return `<section id="integration"><h2>接入步骤</h2>${parts.join("")}</section>`;
}

function renderChangelog(info) {
  const text = typeof info.changelog === "string" ? info.changelog.trim() : "";
  if (!text) return "";
  return (
    `<section id="changelog"><h2>变更摘要</h2><details><summary>CHANGELOG（最近若干行）</summary>` +
    `<pre>${escapeHtml(text)}</pre></details></section>`
  );
}

// 复制按钮：优先 Clipboard API，失败/不可用时降级到临时 textarea + execCommand。
const COPY_SCRIPT = `document.addEventListener("click",function(e){var b=e.target&&e.target.closest?e.target.closest("[data-copy]"):null;if(!b)return;e.preventDefault();var t=b.getAttribute("data-copy")||"";var done=function(){var o=b.textContent;b.textContent="已复制";setTimeout(function(){b.textContent=o;},1200);};var fallback=function(){var ta=document.createElement("textarea");ta.value=t;ta.setAttribute("readonly","");ta.style.position="fixed";ta.style.opacity="0";document.body.appendChild(ta);ta.select();try{document.execCommand("copy");done();}catch(_){}document.body.removeChild(ta);};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done,fallback);}else{fallback();}});`;

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

/**
 * 渲染自描述页面。字段全部来自 info，缺哪段就不渲染哪段。
 * 页面自包含（无外链 CSS/JS/字体），离线可看；复制按钮用内联脚本，拿不到剪贴板时降级。
 * @param {object} info 与 /info JSON 相同的数据
 * @returns {string} 完整 HTML
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
  const publicUrlText = info.deployment?.publicUrl || "";
  const publicUrl = publicUrlText
    ? `<a href="${escapeHtml(publicUrlText)}">${escapeHtml(publicUrlText)}</a>${copyButton(publicUrlText)}`
    : "";
  const generatedAt = formatStartedAt(new Date().toISOString());

  const blocks = [
    {
      id: "deploy",
      title: "部署",
      html: renderSection("deploy", "部署", info.deployment, info.labels),
    },
    {
      id: "storage",
      title: "存储",
      html: renderSection("storage", "存储", info.storage, info.labels),
    },
    {
      id: "limits",
      title: "限制",
      html: renderSection("limits", "限制", info.limits, info.labels),
    },
    { id: "endpoints", title: "端点", html: renderEndpoints(info.endpoints, publicUrlText) },
    { id: "integration", title: "接入步骤", html: renderIntegration(info.integration) },
    { id: "changelog", title: "变更摘要", html: renderChangelog(info) },
  ].filter((b) => b.html);
  const toc = blocks.length
    ? `<nav class="toc">${blocks
        .map((b) => `<a href="#${b.id}">${escapeHtml(b.title)}</a>`)
        .join("")}</nav>`
    : "";

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(service)} ${escapeHtml(version)} · 服务自描述</title>
<link rel="alternate" type="application/json" href="?format=json">
<style>
:root{color-scheme:light dark}
body{font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:32px;background:#fafafa;color:#18181b}
h1{font-size:20px;margin:0 0 4px}h1 .ver{color:#71717a;font-weight:400}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#71717a;margin:24px 0 8px}
h2:target{color:#2563eb}
.sub{color:#71717a;margin:0 0 8px}
nav.toc{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 0}
nav.toc a{color:#52525b;text-decoration:none;border:1px solid #e4e4e7;border-radius:999px;padding:3px 10px;background:#fff;font-size:12px}
nav.toc a:hover{border-color:#a1a1aa;color:#18181b}
table{border-collapse:collapse;width:100%;max-width:760px;background:#fff;border:1px solid #e4e4e7;border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:7px 12px;border-top:1px solid #f4f4f5;vertical-align:top}
th{width:190px;color:#52525b;font-weight:500}td{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
code{background:#f4f4f5;padding:1px 5px;border-radius:4px}
.tag{background:#eef2ff;color:#3730a3;border-radius:4px;padding:0 5px;font-size:11px}
.tag.ok{background:#dcfce7;color:#166534}
.tag.warn{background:#fef3c7;color:#92400e}
.copy{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;background:#fff;border:1px solid #d4d4d8;color:#52525b;border-radius:4px;padding:1px 6px;cursor:pointer;margin-left:6px;vertical-align:middle}
.copy:hover{background:#f4f4f5;color:#18181b}
.snippet{max-width:760px;margin:10px 0 0}
.snip-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:#52525b;margin-bottom:4px}
.snip-head .copy{margin-left:0}
pre{background:#18181b;color:#e4e4e7;padding:14px;border-radius:8px;overflow:auto;max-width:760px;font-size:12px;margin:0}
footer{margin-top:28px;color:#71717a;font-size:12px;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
footer a{color:#52525b}
@media (max-width:640px){
  body{padding:16px}
  table,thead,tbody,tr,th,td{display:block;width:auto}
  tr{border-top:1px solid #f4f4f5;padding:6px 0}
  tr:first-child{border-top:0}
  th{width:auto;border-top:0;padding-bottom:0;font-size:12px}
  td{border-top:0;padding-top:2px}
}
@media (prefers-color-scheme:dark){
  body{background:#09090b;color:#fafafa}
  table,nav.toc a,.copy{background:#18181b;border-color:#27272a}
  th,td,tr{border-color:#27272a}
  th,nav.toc a,footer a{color:#a1a1aa}
  code{background:#27272a}
  .tag{background:#312e81;color:#c7d2fe}
  .tag.ok{background:#14532d;color:#bbf7d0}
  .tag.warn{background:#78350f;color:#fde68a}
  .copy{color:#a1a1aa}.copy:hover{background:#27272a;color:#fafafa}
}
</style></head><body>
<h1>${escapeHtml(service)} <span class="ver">${escapeHtml(version)}</span></h1>
${subtitle ? `<p class="sub">${subtitle}</p>` : ""}
${toc}
${blocks.map((b) => b.html).join("\n")}
<footer>
${publicUrl ? `<span>访问地址 ${publicUrl}</span>` : ""}
<span><a href="?format=json">JSON</a> · <a href="?format=html">HTML</a></span>
<span>免鉴权、不含密钥 · 生成于 ${escapeHtml(generatedAt)}</span>
</footer>
<script>${COPY_SCRIPT}</script>
</body></html>`;
}
