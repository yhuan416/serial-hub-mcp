import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dirStats,
  formatBytes,
  negotiateInfoFormat,
  renderInfoHtml,
  resolvePublicUrl,
} from "../src/sdk/info-page.js";
import { buildMcpInfo } from "../src/info.js";

const req = (headers = {}) => ({ headers });

test("/info 协商：?format 优先，其次 Accept", () => {
  assert.equal(negotiateInfoFormat(req({}), new URL("http://x/info?format=html")), "html");
  assert.equal(
    negotiateInfoFormat(req({ accept: "text/html" }), new URL("http://x/info?format=json")),
    "json",
  );
  assert.equal(
    negotiateInfoFormat(
      req({ accept: "text/html,application/xhtml+xml" }),
      new URL("http://x/info"),
    ),
    "html",
  );
  assert.equal(negotiateInfoFormat(req({ accept: "*/*" }), new URL("http://x/info")), "json");
  assert.equal(
    negotiateInfoFormat(req({ accept: "application/json" }), new URL("http://x/info")),
    "json",
  );
  assert.equal(
    negotiateInfoFormat(req({ accept: "application/json, text/html" }), new URL("http://x/info")),
    "json",
  );
  assert.equal(
    negotiateInfoFormat(req({ accept: "text/html, application/json" }), new URL("http://x/info")),
    "html",
  );
  assert.equal(negotiateInfoFormat(req({}), new URL("http://x/info?format=bogus")), "json");
});

test("/info 页面：五段骨架、中文标签、HTML 转义、JSON 链接", () => {
  const html = renderInfoHtml({
    service: "demo",
    version: "1.2.3",
    summary: "示例服务",
    deployment: { runtime: "node v22", publicUrl: "http://192.168.4.50:8788", uptimeSeconds: 90 },
    storage: { dataDir: "/data", dataDirSize: "2 个文件 · 1.5 KiB" },
    limits: { bodyBytes: "4 MiB" },
    endpoints: { mcp: { path: "/mcp", auth: "Bearer", desc: "端点" } },
    integration: { hint: "贴到客户端", snippets: [{ title: "配置", code: '{"a":"<b>"}' }] },
    changelog: "## 1.2.3\n- 新增 <info>",
  });
  for (const section of ["部署", "存储", "限制", "端点", "接入步骤", "变更摘要"]) {
    assert.ok(html.includes(section), `缺少段落 ${section}`);
  }
  assert.ok(html.includes("运行时"), "英文键应映射成中文标签");
  assert.ok(html.includes('href="?format=json"'));
  assert.ok(html.includes("&lt;b&gt;"), "代码块必须转义");
  assert.ok(!html.includes("<b>"), "不能输出原始 HTML");
  assert.ok(html.includes("运行 1m"));
});

test("publicUrl：PUBLIC_URL 优先，其次 Host 头，最后回环兜底", () => {
  assert.equal(
    resolvePublicUrl({ envUrl: "http://hub.example.com/", req: req({ host: "10.0.0.1:8788" }) }),
    "http://hub.example.com",
  );
  assert.equal(
    resolvePublicUrl({ req: req({ host: "192.168.4.50:8792" }) }),
    "http://192.168.4.50:8792",
  );
  assert.equal(
    resolvePublicUrl({ req: req({ host: "mcp.example.com", "x-forwarded-proto": "https" }) }),
    "https://mcp.example.com",
  );
  assert.equal(
    resolvePublicUrl({ req: req({ host: "bad host/../x" }), fallback: "http://127.0.0.1:8787/" }),
    "http://127.0.0.1:8787",
  );
  assert.equal(resolvePublicUrl({}), null);
});

test("buildMcpInfo：stdio 模式没有 HTTP 端点，仍能自描述", () => {
  const info = buildMcpInfo({
    version: "9.9.9",
    storeMode: "v2",
    paths: {},
    storeOptions: {},
    toolsCount: 19,
    startedAtMs: Date.now() - 1000,
  });
  assert.equal(info.service, "serial-hub-mcp");
  assert.equal(info.deployment.transport, "stdio");
  assert.equal(info.endpoints, undefined);
  assert.equal(info.deployment.listen, undefined);
  assert.ok(info.integration.snippets[0].code.includes("stdio"));
});

test("formatBytes / dirStats 只统计直接子文件", () => {
  assert.equal(formatBytes(1024), "1.0 KiB");
  assert.equal(formatBytes(1536 * 1024), "1.5 MiB");
  assert.equal(formatBytes(0), "0 B");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "info-dir-"));
  try {
    fs.writeFileSync(path.join(dir, "a.log"), Buffer.alloc(100));
    fs.writeFileSync(path.join(dir, "b.log"), Buffer.alloc(24));
    fs.mkdirSync(path.join(dir, "sub"));
    const st = dirStats(dir);
    assert.equal(st.files, 2);
    assert.equal(st.sizeBytes, 124);
    assert.equal(st.entries, 3);
    assert.equal(dirStats(path.join(dir, "missing")), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("/info 页面：单位在渲染层补全（JSON 保持数值）", () => {
  const html = renderInfoHtml({
    service: "s",
    version: "1",
    deployment: { startedAt: "2026-11-24T03:38:20.859Z", uptimeSeconds: 2337 },
    limits: { bodyBytes: 4 * 1024 * 1024, flushMs: 500, cacheTtlDays: 7, baudMax: 5000000 },
  });
  assert.ok(html.includes("4.0 MiB"), "字节数应格式化");
  assert.ok(html.includes("500 ms"), "毫秒应带单位");
  assert.ok(html.includes("7 天"), "天数应带单位");
  assert.ok(html.includes("5,000,000 baud"), "波特率应带千分位与单位");
  assert.ok(html.includes("2026-11-24 03:38:20 UTC"), "启动时间应简洁展示");
  assert.ok(html.includes("38m（2337 秒）"), "运行时长应人性化");
});

test("/info 页面：锚点导航、复制按钮、端点分色与可点击规则", () => {
  const html = renderInfoHtml({
    service: "s",
    version: "1",
    deployment: { publicUrl: "http://h:1" },
    endpoints: {
      health: { path: "/health", auth: "免鉴权", desc: "健康检查" },
      mcp: { path: "/mcp", auth: "Bearer token", desc: "MCP" },
    },
    integration: { snippets: [{ title: "配置", code: "echo hi" }] },
  });
  assert.ok(html.includes('<nav class="toc">'), "应有段内导航");
  assert.ok(html.includes("data-copy="), "应有复制按钮");
  assert.ok(html.includes('<a href="/health">'), "免鉴权 GET 端点应可点击");
  assert.ok(!html.includes('<a href="/mcp">'), "POST 端点不应做成链接");
  assert.ok(html.includes("tag ok"), "免鉴权应使用绿色标签");
  assert.ok(html.includes("tag warn"), "Bearer 应使用警示色标签");
});
