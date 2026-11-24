// 串口工具装配：conn（连接/收发/接收窗口/落盘/打开记录）+ log（日志）+ profile（参数复用）+ service_info。
import { fileURLToPath } from "node:url";
import { createServiceInfoTool } from "../sdk/service-info.js";
import { connTools } from "./conn.js";
import { logTools } from "./log.js";
import { profileTools } from "./profile.js";

const CHANGELOG_PATH = fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url));

export function buildTools(manager, logStore, { version = "unknown", infoExtra } = {}) {
  const baseTools = [...connTools(manager), ...logTools(logStore), ...profileTools()].filter(
    (t) => !t.hidden,
  );
  return [
    ...baseTools,
    createServiceInfoTool({
      service: "serial-hub-mcp",
      version,
      changelogPath: CHANGELOG_PATH,
      // HTTP 模式下由 server.js 提供部署/存储/限额；stdio 时同样可用。
      ...(typeof infoExtra === "function" ? { dynamic: infoExtra } : {}),
      extra: { tools_count: baseTools.length + 1 },
    }),
  ];
}
