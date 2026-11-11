// 远端串口链路 —— scheme 注册表。
//
// 每个 scheme 的 connector 负责建链 + HELLO，返回 { rpc, info }；
// 字节面语义（READ/TRANSACT/LOG_*）由 src/remote/connection.js 统一实现。
// 新增传输只需 registerRemoteScheme(scheme, connector)，open/tool 层无需改动。
//
// 详见 docs/remote-link-protocol.md 与 docs/hub-architecture.md「端点模板注册」。

import { connectTcp } from "../remote/tcp.js";

const schemes = new Map();

/** 规划中的 scheme（用于错误提示/文档，不代表已实现）。 */
export const PLANNED_SCHEMES = ["udp", "kcp", "mqtt", "ws"];

/** 注册/覆盖一个远端传输 connector。 */
export function registerRemoteScheme(scheme, connector) {
  if (!scheme || typeof connector !== "function") {
    throw new Error("registerRemoteScheme: scheme 与 connector 必填");
  }
  schemes.set(String(scheme).toLowerCase(), connector);
  return connector;
}

/** 已注册的远端 scheme。 */
export function listRemoteSchemes() {
  return [...schemes.keys()];
}

/** 从 endpoint 提取 scheme（小写）；非法 URI 返回 null。 */
export function endpointScheme(endpoint) {
  if (typeof endpoint !== "string") return null;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(endpoint);
  return m ? m[1].toLowerCase() : null;
}

/** 按 endpoint 的 scheme 建链；返回 { rpc, info }。 */
export async function createRemoteLink(cfg) {
  const scheme = endpointScheme(cfg.endpoint);
  if (!scheme) {
    throw new Error(`remote endpoint 非法: ${cfg.endpoint}，应形如 tcp://host:port`);
  }
  const connector = schemes.get(scheme);
  if (!connector) {
    const ready = listRemoteSchemes();
    const hint = ready.length ? `已注册: ${ready.join(", ")}` : "当前没有已注册的远端 scheme";
    throw new Error(
      `remote scheme "${scheme}" 尚未实现（${hint}；规划: ${PLANNED_SCHEMES.join(", ")}）。` +
        "契约见 docs/remote-link-protocol.md",
    );
  }
  return connector(cfg);
}

registerRemoteScheme("tcp", connectTcp);
