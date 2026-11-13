#!/usr/bin/env node
// serial-hub-server — 在 x86/Linux 上部署的远端串口服务。
//
// 用法：
//   serial-hub-server --listen 0.0.0.0:7000 --token <token>
//   serial-hub-server --ports /dev/ttyUSB,/dev/ttyACM --ring-bytes 128MiB
//
// 环境变量：
//   SERIAL_HUB_SERVER_TOKEN / SERIAL_HUB_SERVER_LISTEN / SERIAL_HUB_SERVER_DATA_DIR
//   SERIAL_HUB_SERVER_PORTS  SERIAL_HUB_SERVER_RING_BYTES  SERIAL_HUB_SERVER_RETENTION_BYTES
//
// 说明：token 缺省时会在 data-dir/token 生成并复用（0600），不会打印明文。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { HubServer } from "./server.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseBytes(v, fallback) {
  if (v == null || v === "") return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?i?b?)?$/i.exec(String(v).trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = (m[2] || "").toLowerCase();
  const mul = unit.startsWith("t")
    ? 1024 ** 4
    : unit.startsWith("g")
      ? 1024 ** 3
      : unit.startsWith("m")
        ? 1024 ** 2
        : unit.startsWith("k")
          ? 1024
          : 1;
  return Math.floor(n * mul);
}

function parseListen(v, fallback) {
  if (!v) return fallback;
  const s = String(v);
  const idx = s.lastIndexOf(":");
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : fallback.port);
  if (idx < 0) return { host: "0.0.0.0", port: num(s) };
  return { host: s.slice(0, idx) || "0.0.0.0", port: num(s.slice(idx + 1)) };
}

function dataDirOf() {
  return (
    argValue("--data-dir") ||
    process.env.SERIAL_HUB_SERVER_DATA_DIR ||
    path.join(os.homedir(), ".local", "share", "serial-hub-server")
  );
}

function tokenOf(dataDir) {
  const fromArg = argValue("--token") || process.env.SERIAL_HUB_SERVER_TOKEN;
  if (fromArg) return fromArg;
  const file = path.join(dataDir, "token");
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t) return t;
  } catch (_) {}
  const t = crypto.randomBytes(16).toString("hex");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, t, { mode: 0o600 });
  } catch (_) {}
  return t;
}

async function main() {
  const dataDir = dataDirOf();
  fs.mkdirSync(dataDir, { recursive: true });

  const listen = parseListen(argValue("--listen") || process.env.SERIAL_HUB_SERVER_LISTEN, {
    host: "0.0.0.0",
    port: 7000,
  }) || { host: "0.0.0.0", port: 7000 };
  const portsArg = argValue("--ports") || process.env.SERIAL_HUB_SERVER_PORTS || "";
  const ports = portsArg
    ? portsArg
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : ["/dev/ttyUSB", "/dev/ttyACM", "/dev/serial/", "COM"]; // 默认只暴露常用 USB/串口设备
  const token = tokenOf(dataDir);

  const server = new HubServer({
    dataDir,
    token,
    fwVersion: pkg.version,
    portFilter: ports,
    ringBytes: parseBytes(
      argValue("--ring-bytes") || process.env.SERIAL_HUB_SERVER_RING_BYTES,
      64 * 1024 * 1024,
    ),
    segmentBytes: parseBytes(argValue("--segment-bytes"), 64 * 1024 * 1024),
    retentionBytes: parseBytes(
      argValue("--retention-bytes") || process.env.SERIAL_HUB_SERVER_RETENTION_BYTES,
      4 * 1024 * 1024 * 1024,
    ),
    retentionDays: Number(argValue("--retention-days") || 7),
    ramEntries: Number(argValue("--ram-entries") || 20000),
    maxFrame: parseBytes(argValue("--max-frame"), 1024 * 1024),
    maxHoldMs: Number(argValue("--max-hold-ms") || 30000),
    scanIntervalMs: Number(argValue("--scan-interval-ms") || 2000),
    captureLingerMs: Number(
      argValue("--capture-linger-ms") || process.env.SERIAL_HUB_SERVER_CAPTURE_LINGER_MS || 60000,
    ),
    captureMaxBytes: parseBytes(
      argValue("--capture-max-bytes") || process.env.SERIAL_HUB_SERVER_CAPTURE_MAX_BYTES,
      128 * 1024 * 1024,
    ),
    v1WindowBytes: parseBytes(
      argValue("--window-bytes") || process.env.SERIAL_HUB_SERVER_WINDOW_BYTES,
      256 * 1024,
    ),
    v1MaxWindowBytes: parseBytes(
      argValue("--max-window-bytes") || process.env.SERIAL_HUB_SERVER_MAX_WINDOW_BYTES,
      1024 * 1024,
    ),
    v1LeaseMs: Number(argValue("--lease-ms") || process.env.SERIAL_HUB_SERVER_LEASE_MS || 30000),
    defaults: {
      baud_rate: Number(argValue("--baud") || 115200),
      data_bits: 8,
      stop_bits: 1,
      parity: "none",
      flow_control: "none",
    },
  });

  const addr = await server.listen(listen);
  const where =
    addr && typeof addr === "object"
      ? `${addr.address}:${addr.port}`
      : `${listen.host}:${listen.port}`;
  console.log(`[serial-hub-server] v${pkg.version} listening on ${where}`);
  console.log(`[serial-hub-server] data-dir=${dataDir} token-file=${path.join(dataDir, "token")}`);
  const list = server.manager.list();
  console.log(
    `[serial-hub-server] ports=${list.length}${list.length ? ` (${list.map((p) => p.id).join(", ")})` : ""}`,
  );

  const stop = async (sig) => {
    console.log(`[serial-hub-server] ${sig}, shutting down...`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err) => {
  console.error(`[serial-hub-server] fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
