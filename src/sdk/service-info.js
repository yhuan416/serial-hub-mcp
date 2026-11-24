// 标准 service_info 工具：服务名 / 版本 / 端点 / 部署描述 / （可选）变更摘要。
// 让客户端与运维能一致地确认「连的是哪个服务、哪个版本、怎么接」。
//
// 同一份数据同时喂给：
//   - MCP 工具 service_info
//   - HTTP 的 GET /info（JSON 或 ?format=html）
// 两处字段必须一致，详见 docs/info-page.md。

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { defineTool } from "./tool.js";

export function buildServiceInfo(opts = {}) {
  const {
    service,
    version,
    summary,
    build,
    git,
    endpoints,
    deployment,
    storage,
    limits,
    integration,
    changelogPath,
    changelogLines = 20,
    extra,
    dynamic,
  } = opts;
  const info = {
    contract: "info/1",
    service: service || "mcp",
    version: version || "unknown",
  };
  if (summary) info.summary = summary;
  if (build) info.build = build;
  if (git) info.git = git;
  if (endpoints) info.endpoints = endpoints;
  if (deployment) info.deployment = deployment;
  if (storage) info.storage = storage;
  if (limits) info.limits = limits;
  if (integration) info.integration = integration;
  if (extra && typeof extra === "object") Object.assign(info, extra);
  // 动态字段（部署/存储/限额等）：每次调用重新计算，保证 /info 与工具同源。
  if (typeof dynamic === "function") {
    const more = dynamic();
    if (more && typeof more === "object") Object.assign(info, more);
  }
  if (changelogPath && existsSync(changelogPath)) {
    try {
      info.changelog = readFileSync(changelogPath, "utf8")
        .split(/\r?\n/)
        .slice(0, changelogLines)
        .join("\n");
      info.changelog_path = changelogPath;
    } catch (_) {
      /* 读变更文件失败不致命 */
    }
  }
  return info;
}

export function createServiceInfoTool(opts = {}) {
  return defineTool({
    name: opts.name || "service_info",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      opts.description ||
      "返回服务信息：服务名/版本/端点/部署与存储/限额/（可选）变更摘要(changelog)。" +
        "与 HTTP 的 GET /info 同源（那里加 ?format=html 可读版）。",
    inputSchema: z.object({}),
    handler: async () => ({ ok: true, response: buildServiceInfo(opts) }),
  });
}
