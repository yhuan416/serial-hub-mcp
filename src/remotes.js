// remotes.js — MCP 侧的远端服务注册表。
//
// 目的：把「远端端点 + token」保存成配置，list_ports 时自动汇总所有远端端口，
// open 时可用名字引用，不必每次传 endpoint/token。
//
// 配置来源（优先级从高到低）：
//   1) 环境变量 SERIAL_HUB_MCP_REMOTES      —— JSON 字符串（数组或 {remotes:[...]}）
//   2) 环境变量 SERIAL_HUB_MCP_REMOTES_FILE —— 文件路径
//   3) 默认文件 $XDG_CONFIG_HOME/serial-hub-mcp/remotes.json
//
// 条目：
//   {
//     "name": "lab-x86",                     // 必填，唯一
//     "endpoint": "tcp://192.168.1.50:7000", // 必填
//     "token": "…",                          // 可选；与 token_env 二选一
//     "token_env": "LAB_SHUB_TOKEN",         // 可选：从环境变量取 token
//     "timeout_ms": 15000,                   // 可选
//     "enabled": true                        // 可选，false 则忽略
//   }
//
// 文件示例：
//   { "remotes": [ { "name": "lab", "endpoint": "tcp://192.168.1.50:7000", "token": "…" } ] }

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 15000;

function defaultConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "serial-hub-mcp", "remotes.json");
}

function normalizeOne(raw, warnings, index) {
  if (!raw || typeof raw !== "object") {
    warnings.push(`remotes[${index}] 不是对象，已忽略`);
    return null;
  }
  if (raw.enabled === false) return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const endpoint = typeof raw.endpoint === "string" ? raw.endpoint.trim() : "";
  if (!name) {
    warnings.push(`remotes[${index}] 缺少 name，已忽略`);
    return null;
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(endpoint)) {
    warnings.push(`remote "${name}" 的 endpoint 非法（应形如 tcp://host:port），已忽略`);
    return null;
  }
  let token = typeof raw.token === "string" && raw.token ? raw.token : null;
  if (!token && typeof raw.token_env === "string" && raw.token_env) {
    const v = process.env[raw.token_env];
    if (v) token = v;
    else warnings.push(`remote "${name}" 的 token_env=${raw.token_env} 未设置（token 为空）`);
  }
  const timeout = Number(raw.timeout_ms);
  return {
    name,
    endpoint,
    token,
    timeout_ms: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    note: typeof raw.note === "string" ? raw.note : null,
  };
}

function parseConfig(text, source, warnings) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    warnings.push(`${source} 不是合法 JSON：${err.message}`);
    return [];
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data && data.remotes)
      ? data.remotes
      : null;
  if (!list) {
    warnings.push(`${source} 缺少 remotes 数组，已忽略`);
    return [];
  }
  const out = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const r = normalizeOne(list[i], warnings, i);
    if (!r) continue;
    if (seen.has(r.name)) {
      warnings.push(`remote 名称重复："${r.name}"，后一个已忽略`);
      continue;
    }
    seen.add(r.name);
    out.push(r);
  }
  return out;
}

/**
 * 读取远端注册表（每次调用重新读取，便于改配置后立即生效）。
 * @returns {{file:string|null, fromEnv:boolean, remotes:Array, warnings:string[]}}
 */
export function loadRemotes() {
  const warnings = [];
  const inline = process.env.SERIAL_HUB_MCP_REMOTES;
  if (inline && inline.trim()) {
    return {
      file: null,
      fromEnv: true,
      remotes: parseConfig(inline, "SERIAL_HUB_MCP_REMOTES", warnings),
      warnings,
    };
  }
  const file = process.env.SERIAL_HUB_MCP_REMOTES_FILE || defaultConfigPath();
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (_) {
    return { file, fromEnv: false, remotes: [], warnings };
  }
  return { file, fromEnv: false, remotes: parseConfig(text, file, warnings), warnings };
}

/** 按名字取远端；不存在时抛出带可用列表的错误。 */
export function resolveRemote(name) {
  const { remotes } = loadRemotes();
  const hit = remotes.find((r) => r.name === name);
  if (hit) return hit;
  const names = remotes.map((r) => r.name);
  throw new Error(
    `remote 不存在: ${name}${names.length ? `（可用: ${names.join(", ")}）` : "（未配置任何 remote）"}`,
  );
}
