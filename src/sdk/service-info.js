// 标准 service_info 工具：服务名 / 版本 / （可选）变更摘要。
// 让客户端与运维能一致地确认「连的是哪个服务、哪个版本」。

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { defineTool } from "./tool.js";

export function buildServiceInfo(opts = {}) {
  const {
    service,
    version,
    build,
    git,
    endpoints,
    changelogPath,
    changelogLines = 20,
    extra,
  } = opts;
  const info = {
    service: service || "mcp",
    version: version || "unknown",
  };
  if (build) info.build = build;
  if (git) info.git = git;
  if (endpoints) info.endpoints = endpoints;
  if (extra && typeof extra === "object") Object.assign(info, extra);
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
    description:
      opts.description ||
      "返回服务信息：服务名/版本/端点/（可选）变更摘要(changelog)，用于确认部署版本与接入方式。",
    inputSchema: z.object({}),
    handler: async () => ({ ok: true, response: buildServiceInfo(opts) }),
  });
}
