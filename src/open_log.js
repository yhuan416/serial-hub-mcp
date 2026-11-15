import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// open 成功后的去重索引：同一端口同一波特率只留一行，更新打开时间。
// 不存 token。容器里用 SERIAL_HUB_MCP_OPENS_FILE=/data/opens.json。

const MAX_ROWS = 200;

function opensFile() {
  if (process.env.SERIAL_HUB_MCP_OPENS_FILE) return process.env.SERIAL_HUB_MCP_OPENS_FILE;
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "serial-hub-mcp", "opens.json");
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(opensFile(), "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

function save(rows) {
  const fp = opensFile();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(rows, null, 2));
}

function keyOf(transport, endpoint, portId, baud) {
  if (transport === "remote") return `${endpoint || ""}|${portId}|${baud}`;
  return `${portId}|${baud}`;
}

function recordOpen(status, name) {
  const transport = status?.transport === "remote" ? "remote" : "serial";
  const baud = Number(status?.config?.baud_rate ?? 115200);
  const endpoint = status?.endpoint || null;
  const portId =
    transport === "remote"
      ? status?.port || status?.config?.port_id || null
      : status?.port || status?.config?.port || null;
  if (!portId || !Number.isFinite(baud)) return null;
  const key = keyOf(transport, endpoint, portId, baud);
  const now = new Date().toISOString();
  const label = typeof name === "string" && name.trim() ? name.trim() : null;
  const rows = load();
  let row = rows.find((r) => r.key === key);
  if (!row) {
    row = {
      key,
      name: label,
      transport,
      endpoint,
      port_id: portId,
      baud_rate: baud,
      first_opened_at: now,
      last_opened_at: now,
      open_count: 1,
    };
    rows.push(row);
  } else {
    row.last_opened_at = now;
    row.open_count = (row.open_count || 0) + 1;
    if (label) row.name = label;
    row.transport = transport;
    row.endpoint = endpoint;
    row.port_id = portId;
    row.baud_rate = baud;
  }
  rows.sort((a, b) => String(a.last_opened_at).localeCompare(String(b.last_opened_at)));
  const kept = rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows;
  save(kept);
  return kept.find((r) => r.key === key) || row;
}

function listOpens({ port, name } = {}) {
  let rows = load();
  if (port) rows = rows.filter((r) => r.port_id === port);
  if (name) {
    const q = name.toLowerCase();
    rows = rows.filter((r) => r.name && r.name.toLowerCase().includes(q));
  }
  return rows.sort((a, b) => String(b.last_opened_at).localeCompare(String(a.last_opened_at)));
}

export { recordOpen, listOpens, opensFile };
