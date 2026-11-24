// HubServer — x86 远端串口服务。只接受二进制帧（魔数 SH）。

import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PortManager } from "./ports.js";
import { isV1Magic, V1Connection } from "./v1.js";
import { buildHubInfo } from "./info.js";
import { negotiateInfoFormat, renderInfoHtml } from "../sdk/info-page.js";

const HTTP_MAX_HEADER = 16 * 1024;
const HTTP_REASONS = {
  200: "OK",
  400: "Bad Request",
  404: "Not Found",
  405: "Method Not Allowed",
  431: "Request Header Fields Too Large",
};

function nowMs() {
  return Date.now();
}

export class HubServer {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {string} [opts.token]
   * @param {string} [opts.fwVersion]
   * @param {number} [opts.maxFrame]
   * @param {number} [opts.maxHoldMs]
   * @param {number} [opts.ringBytes]
   * @param {number} [opts.ramEntries]
   * @param {number} [opts.segmentBytes]
   * @param {number} [opts.retentionBytes]
   * @param {number} [opts.retentionDays]
   * @param {string[]} [opts.portFilter]
   * @param {number} [opts.scanIntervalMs]
   * @param {Function} [opts.serialFactory]
   * @param {Function} [opts.listPorts]
   */
  constructor(opts = {}) {
    this.token = opts.token || null;
    this.fwVersion = opts.fwVersion || "0.1.0";
    this.maxFrame = Math.max(4096, opts.maxFrame ?? 1024 * 1024);
    this.manager = new PortManager({
      dataDir: opts.dataDir,
      ringBytes: opts.ringBytes,
      ramEntries: opts.ramEntries,
      segmentBytes: opts.segmentBytes,
      retentionBytes: opts.retentionBytes,
      retentionDays: opts.retentionDays,
      portFilter: opts.portFilter,
      serialFactory: opts.serialFactory,
      listPorts: opts.listPorts,
      defaults: opts.defaults,
    });
    this.manager.maxHoldMs = opts.maxHoldMs ?? 30000;
    this.scanIntervalMs = opts.scanIntervalMs ?? 2000;
    this.captureLingerMs = Math.max(0, opts.captureLingerMs ?? 60000);
    this.dataDir = opts.dataDir || null;
    this.captureMaxBytes = Math.max(1024, opts.captureMaxBytes ?? 128 * 1024 * 1024);
    this._loadCaptureMax();
    this.v1WindowBytes = Math.max(4096, opts.v1WindowBytes ?? 256 * 1024);
    this.v1MaxWindowBytes = Math.max(this.v1WindowBytes, opts.v1MaxWindowBytes ?? 1024 * 1024);
    this.v1LeaseMs = Math.max(1000, opts.v1LeaseMs ?? 30000);
    this.v1MaxLineBytes = Math.max(256, opts.v1MaxLineBytes ?? 4096);
    this.bootId = opts.bootId || crypto.randomBytes(4).toString("hex");
    this.tokenSource = opts.tokenSource || null;
    this.v1Conns = new Set();
    this.sockets = new Set();
    this.server = net.createServer((socket) => this._accept(socket));
    this.startedAt = nowMs();
  }

  async listen({ host = "0.0.0.0", port = 7000 } = {}) {
    await this.manager.scan();
    this.manager.startAutoScan(this.scanIntervalMs);
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    return this.server.address();
  }

  async close() {
    for (const c of this.v1Conns) c.destroy();
    this.v1Conns.clear();
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.manager.close();
    await new Promise((resolve) => this.server.close(resolve));
  }

  _accept(socket) {
    socket.setNoDelay(true);
    const st = {
      socket,
      raw: Buffer.alloc(0),
      mode: null,
      v1: null,
      httpBuf: Buffer.alloc(0),
      httpDone: false,
      closed: false,
    };
    this.sockets.add(socket);
    socket.on("data", (chunk) =>
      this._onRaw(st, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    socket.on("error", () => {});
    socket.on("close", () => {
      st.closed = true;
      if (st.v1) {
        this.v1Conns.delete(st.v1);
        st.v1.destroy();
      }
      this.sockets.delete(socket);
    });
  }

  /** 只接受二进制帧（魔数 SH）；首字节是 HTTP 方法时当作自描述请求（/info、/health）。 */
  _onRaw(st, chunk) {
    if (st.mode === "v1") {
      st.v1.onData(chunk);
      return;
    }
    if (st.mode === "http") {
      this._onHttp(st, chunk);
      return;
    }
    st.raw = st.raw.length ? Buffer.concat([st.raw, chunk]) : chunk;
    if (st.raw.length >= 4) {
      const head = st.raw.toString("latin1", 0, 4);
      if (head === "GET " || head === "HEAD" || head === "POST" || head === "OPTI") {
        st.mode = "http";
        const pending = st.raw;
        st.raw = Buffer.alloc(0);
        this._onHttp(st, pending);
        return;
      }
    }
    if (st.raw.length < 2) return;
    if (!isV1Magic(st.raw)) {
      st.socket.destroy();
      return;
    }
    st.mode = "v1";
    const conn = new V1Connection(this, st.socket, st.raw);
    st.v1 = conn;
    this.v1Conns.add(conn);
    st.raw = Buffer.alloc(0);
  }

  _onHttp(st, chunk) {
    if (st.httpDone) return;
    if (chunk.length) {
      st.httpBuf = st.httpBuf.length ? Buffer.concat([st.httpBuf, chunk]) : chunk;
    }
    if (st.httpBuf.length > HTTP_MAX_HEADER) {
      this._respondHttp(
        st,
        431,
        { "content-type": "application/json; charset=utf-8" },
        JSON.stringify({ ok: false, error: "request header too large" }),
        false,
      );
      return;
    }
    const end = st.httpBuf.indexOf("\r\n\r\n");
    if (end < 0) return;
    const head = st.httpBuf.subarray(0, end).toString("latin1");
    st.httpBuf = Buffer.alloc(0);
    this._handleHttpRequest(st, head);
  }

  _handleHttpRequest(st, head) {
    const lines = head.split("\r\n");
    const m = /^([A-Z]+)\s+(\S+)\s+HTTP\/\d(?:\.\d)?$/.exec(lines[0] || "");
    if (!m) {
      return this._respondHttp(
        st,
        400,
        { "content-type": "application/json; charset=utf-8" },
        JSON.stringify({ ok: false, error: "bad request" }),
        false,
      );
    }
    const method = m[1];
    let url;
    try {
      url = new URL(m[2], "http://localhost");
    } catch (_) {
      return this._respondHttp(
        st,
        400,
        { "content-type": "application/json; charset=utf-8" },
        JSON.stringify({ ok: false, error: "bad url" }),
        false,
      );
    }
    const headOnly = method === "HEAD";
    if (method !== "GET" && method !== "HEAD") {
      return this._respondHttp(
        st,
        405,
        { "content-type": "application/json; charset=utf-8", allow: "GET, HEAD" },
        JSON.stringify({ ok: false, error: "method not allowed" }),
        false,
      );
    }
    const headers = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const reqLike = { headers };
    // 免鉴权、不含密钥：只读部署形态与端口列表。
    if (url.pathname === "/info" || url.pathname === "/" || url.pathname === "/index.html") {
      const info = buildHubInfo(this, { version: this.fwVersion, req: reqLike });
      const isRoot = url.pathname === "/" || url.pathname === "/index.html";
      if (isRoot || negotiateInfoFormat(reqLike, url) === "html") {
        const html = renderInfoHtml(info);
        return this._respondHttp(
          st,
          200,
          { "content-type": "text/html; charset=utf-8" },
          html,
          headOnly,
        );
      }
      return this._respondHttp(
        st,
        200,
        { "content-type": "application/json; charset=utf-8" },
        JSON.stringify(info),
        headOnly,
      );
    }
    if (url.pathname === "/health") {
      const body = JSON.stringify({
        ok: true,
        service: "serial-hub-server",
        version: this.fwVersion,
        transport: "tcp",
        ports: this.manager.list().length,
        uptimeSeconds: Math.max(0, Math.round((nowMs() - this.startedAt) / 1000)),
      });
      return this._respondHttp(
        st,
        200,
        { "content-type": "application/json; charset=utf-8" },
        body,
        headOnly,
      );
    }
    return this._respondHttp(
      st,
      404,
      { "content-type": "application/json; charset=utf-8" },
      JSON.stringify({ ok: false, error: `not found: ${url.pathname}` }),
      headOnly,
    );
  }

  _respondHttp(st, status, headers, body, headOnly) {
    if (st.httpDone) return;
    st.httpDone = true;
    const buf = Buffer.from(body ?? "", "utf8");
    const lines = [
      `HTTP/1.1 ${status} ${HTTP_REASONS[status] || "OK"}`,
      `content-length: ${buf.length}`,
      "connection: close",
      "cache-control: no-store",
      "vary: Accept",
    ];
    for (const [k, v] of Object.entries(headers || {})) lines.push(`${k}: ${v}`);
    try {
      st.socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (!headOnly) st.socket.write(buf);
      st.socket.end();
    } catch (_) {
      st.socket.destroy();
    }
  }

  _captureMaxFile() {
    return this.dataDir ? path.join(this.dataDir, "capture-max-bytes.json") : null;
  }

  _loadCaptureMax() {
    const file = this._captureMaxFile();
    if (!file) return;
    try {
      const n = JSON.parse(fs.readFileSync(file, "utf8")).cap_bytes;
      if (Number.isFinite(n) && n >= 32 * 1024) this.captureMaxBytes = n;
    } catch (_) {}
  }

  setCaptureMaxBytes(raw) {
    let n = Math.floor(Number(raw) || 0);
    const min = 32 * 1024;
    const max = 2 * 1024 * 1024;
    if (n < min) n = min;
    if (n > max) n = max;
    n &= ~0xfff;
    if (n < min) n = min;
    this.captureMaxBytes = n;
    let saved = false;
    const file = this._captureMaxFile();
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ cap_bytes: n }));
        saved = true;
      } catch (_) {}
    }
    const live = [...this.manager.ports.values()].some((st) => st.capture && !st.capture.closed);
    return {
      saved,
      applied: live ? "next" : "now",
      note: live
        ? "current capture keeps its buffer until 60s after the last session; not a reboot"
        : "no live capture; the next allocation uses this size",
    };
  }

  v1HelloResult(conn) {
    return {
      fw_version: this.fwVersion,
      board: "x86",
      boot_id: this.bootId,
      session_id: conn.id,
      ports: this.manager.list(),
      caps: {
        push: true,
        mux: true,
        batch: true,
        max_frame: this.maxFrame,
        max_read_bytes: Math.min(Math.floor(this.maxFrame * 0.8), 512 * 1024),
        window: {
          default_bytes: this.v1WindowBytes,
          max_bytes: this.v1MaxWindowBytes,
          ack_interval_bytes: 32768,
        },
        capture: {
          linger_ms: this.captureLingerMs,
          max_bytes: this.captureMaxBytes,
          history: "none",
        },
        can_config: true,
        can_set_lines: true,
        can_break: true,
        lease_ms: this.v1LeaseMs,
        events: false,
      },
      time: {
        epoch_ms: nowMs(),
        synced: true,
        source: "system",
        tick_ms: nowMs() - this.startedAt,
      },
    };
  }
}

export function createHubServer(opts) {
  return new HubServer(opts);
}
