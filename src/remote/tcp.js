// TCP 传输：net.Socket + NDJSON RPC，首帧 HELLO 做鉴权与能力协商。

import net from "node:net";
import { RpcClient } from "./rpc.js";

const DEFAULT_PORT = 7000;

function endpointUrl(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch (_) {
    throw new Error(`endpoint 非法: ${endpoint}，应形如 tcp://host:port`);
  }
  if (url.protocol !== "tcp:") {
    throw new Error(`TCP 适配器不接受 scheme: ${url.protocol.replace(":", "")}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || DEFAULT_PORT);
  if (!host || !Number.isInteger(port) || port <= 0) {
    throw new Error(`endpoint 非法: ${endpoint}，应形如 tcp://host:port`);
  }
  return { host, port };
}

/**
 * 建立 TCP 连接并完成 HELLO。返回 { rpc, info }。
 * @param {object} cfg 连接配置（endpoint/token/各项 timeout）
 */
export async function connectTcp(cfg) {
  const { host, port } = endpointUrl(cfg.endpoint);
  const connectTimeout = cfg.connect_timeout_ms ?? 5000;

  const socket = await new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port });
    s.setNoDelay(true);
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`连接超时: ${cfg.endpoint}`));
    }, connectTimeout);
    s.once("connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const rpc = new RpcClient(socket, { defaultTimeoutMs: cfg.request_timeout_ms ?? 15000 });
  try {
    const hello = await rpc.request(
      "HELLO",
      {
        proto: "v0",
        ...(cfg.token ? { token: cfg.token } : {}),
        client: cfg.client || "serial-hub-mcp",
      },
      { timeoutMs: cfg.hello_timeout_ms ?? 5000 },
    );
    if (!hello || hello.proto !== "v0") {
      throw new Error(`远端协议版本不匹配: ${hello && hello.proto}`);
    }
    return { rpc, info: hello };
  } catch (err) {
    rpc.close();
    throw err;
  }
}
