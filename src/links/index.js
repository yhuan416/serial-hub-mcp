// 本地链路工厂。远端连接不走这里，由 ConnectionManager 直接建二进制会话。

import { createSerialLink, DEFAULT_BAUD, FLOW_MAP, TRANSPORTS } from "./serial.js";

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
  if (transport === "remote") {
    throw new Error("remote 链路不由 createLink 创建");
  }
  const factory = registry.get(transport);
  if (!factory) {
    throw new Error(`未知 transport: ${transport}，可用: ${listLinks().join(" | ")}`);
  }
  return factory(cfg);
}

registerLink("serial", createSerialLink);
