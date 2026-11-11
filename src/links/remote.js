// 远端串口链路（ESP32-style bridge）—— 契约见 docs/remote-link-protocol.md。
//
// 端点按 URI scheme 选择适配器：tcp / udp / kcp / mqtt / ws ...
// 新增传输只需 registerRemoteScheme(scheme, factory)，open/tool 层无需改动。
// 适配器必须产出与 SerialPort 一致的 port 鸭子类型：
//   on('data'|'error'|'close')、open/close/write/drain/flush/set、path
// 并把 Connection 的字节面语义映射到设备的 READ/TRANSACT/LOG_* RPC。

const schemes = new Map();

/** 规划中的 scheme（用于错误提示/文档，不代表已实现）。 */
export const PLANNED_SCHEMES = ["tcp", "udp", "kcp", "mqtt", "ws"];

/** 注册/覆盖一个远端传输适配器。 */
export function registerRemoteScheme(scheme, factory) {
  if (!scheme || typeof factory !== "function") {
    throw new Error("registerRemoteScheme: scheme 与 factory 必填");
  }
  schemes.set(String(scheme).toLowerCase(), factory);
  return factory;
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

export function createRemoteLink(cfg) {
  const scheme = endpointScheme(cfg.endpoint);
  if (!scheme) {
    throw new Error(`remote endpoint 非法: ${cfg.endpoint}，应形如 tcp://host:port`);
  }
  const factory = schemes.get(scheme);
  if (!factory) {
    const ready = listRemoteSchemes();
    const hint = ready.length ? `已注册: ${ready.join(", ")}` : "当前没有已注册的远端 scheme";
    throw new Error(
      `remote scheme "${scheme}" 尚未实现（${hint}；规划: ${PLANNED_SCHEMES.join(", ")}）。` +
        "契约见 docs/remote-link-protocol.md",
    );
  }
  return factory(cfg);
}
