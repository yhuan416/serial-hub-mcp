// 链路工厂 + 注册表。
//
// transport 是「链路类别」：serial（本机）/ remote（远端桥）。
// 远端桥的 endpoint 以 scheme 细分（tcp/udp/kcp/mqtt/ws...）；scheme → adapter 的注册
// 在 remote.js 内维护，后续新增传输只注册，不改 open/tool 层。
//
// 详见 docs/hub-architecture.md「端点模板注册」。

import { createSerialLink, DEFAULT_BAUD, FLOW_MAP, TRANSPORTS } from "./serial.js";
import { createRemoteLink } from "./remote.js";

export { DEFAULT_BAUD, FLOW_MAP, TRANSPORTS };

const registry = new Map();

/** 注册/覆盖一个 transport 适配器。 */
export function registerLink(transport, factory) {
  if (!transport || typeof factory !== "function") {
    throw new Error("registerLink: transport 与 factory 必填");
  }
  registry.set(transport, factory);
  return factory;
}

/** 已注册的 transport 列表。 */
export function listLinks() {
  return [...registry.keys()];
}

/**
 * 按 transport 构建未打开的链路（port 鸭子类型）。
 * @param {{transport?:string}} cfg
 */
export function createLink(cfg) {
  const transport = cfg.transport ?? "serial";
  const factory = registry.get(transport);
  if (!factory) {
    throw new Error(`未知 transport: ${transport}，可用: ${listLinks().join(" | ")}`);
  }
  return factory(cfg);
}

registerLink("serial", createSerialLink);
registerLink("remote", createRemoteLink);
