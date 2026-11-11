import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 连接 profile 持久化：常用端口/端点参数按名字存 JSON，供 open({profile:"name"}) 一条复用。
// 明文（不含凭据），目录可用环境变量覆盖。
// 默认：$XDG_CONFIG_HOME/serial-hub-mcp/profiles.json（缺省 ~/.config/serial-hub-mcp/profiles.json）。

function defaultProfilesDir() {
  if (process.env.SERIAL_HUB_MCP_PROFILES_DIR) return process.env.SERIAL_HUB_MCP_PROFILES_DIR;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "serial-hub-mcp");
}

function defaultProfilesFile() {
  return path.join(defaultProfilesDir(), "profiles.json");
}

function load() {
  const fp = defaultProfilesFile();
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, "utf8")) || {};
  } catch (_) {
    /* 文件损坏按空处理 */
  }
  return {};
}

function save(profiles) {
  const fp = defaultProfilesFile();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(profiles, null, 2));
}

function list() {
  return Object.entries(load()).map(([name, cfg]) => ({ name, ...cfg }));
}

function get(name) {
  return load()[name] || null;
}

function put(name, cfg) {
  if (!name || !name.trim()) throw new Error("profile 名不能为空");
  const all = load();
  all[name] = cfg;
  save(all);
  return get(name);
}

function remove(name) {
  const all = load();
  const existed = name in all;
  delete all[name];
  save(all);
  return existed;
}

export { list, get, put, remove, defaultProfilesFile };
