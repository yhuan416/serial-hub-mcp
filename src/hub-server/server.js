// HubServer — x86 远端串口服务。只接受二进制帧（魔数 SH）。

import net from "node:net";
import crypto from "node:crypto";
import { PortManager } from "./ports.js";
import { isV1Magic, V1Connection } from "./v1.js";

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
    this.captureMaxBytes = Math.max(1024, opts.captureMaxBytes ?? 128 * 1024 * 1024);
    this.v1WindowBytes = Math.max(4096, opts.v1WindowBytes ?? 256 * 1024);
    this.v1MaxWindowBytes = Math.max(this.v1WindowBytes, opts.v1MaxWindowBytes ?? 1024 * 1024);
    this.v1LeaseMs = Math.max(1000, opts.v1LeaseMs ?? 30000);
    this.v1MaxLineBytes = Math.max(256, opts.v1MaxLineBytes ?? 4096);
    this.bootId = opts.bootId || crypto.randomBytes(4).toString("hex");
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

  /** 只接受二进制帧（魔数 SH）。其它首字节直接断开。 */
  _onRaw(st, chunk) {
    if (st.mode === "v1") {
      st.v1.onData(chunk);
      return;
    }
    st.raw = st.raw.length ? Buffer.concat([st.raw, chunk]) : chunk;
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
