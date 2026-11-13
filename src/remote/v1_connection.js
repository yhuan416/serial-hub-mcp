// v1_connection.js — MCP host 侧的 v1 连接（push + 本地缓存）。
//
// 数据面：TCP 二进制帧，后台持续收 DATA，写入 CaptureCache；ACK 做流控。
// 工具面：read/receive/dump_to_file 读本地 ring；log_* 读本地条目索引。
// 这样日志检索不再依赖远端 RPC，也就不会出现单次调用超时。

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { ByteRing } from "../hub-server/ring.js";
import {
  T,
  FLAG_GAP,
  FLAG_BATCH,
  encodeFrame,
  encodeControl,
  encodeAckFrame,
  decodeFrames,
} from "./v1_codec.js";

const READ_CHUNK = 256 * 1024;

function defaultStateFile() {
  const base = process.env.XDG_CACHE_HOME || path.join(requireHome(), ".cache");
  return (
    process.env.SERIAL_HUB_MCP_V1_STATE_FILE || path.join(base, "serial-hub-mcp", "v1-cursors.json")
  );
}

function cursorKey(endpoint, port) {
  return `${endpoint}|${port || ""}`;
}

function readCursor(file, endpoint, port) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data[cursorKey(endpoint, port)] || null;
  } catch (_) {
    return null;
  }
}

function pruneCaptureDirs(parent, keep = 16) {
  try {
    const names = fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const fp = path.join(parent, d.name);
        let mtime = 0;
        try {
          mtime = fs.statSync(fp).mtimeMs;
        } catch (_) {}
        return { fp, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of names.slice(keep)) {
      try {
        fs.rmSync(old.fp, { recursive: true, force: true });
      } catch (_) {}
    }
  } catch (_) {}
}

function writeCursor(file, endpoint, port, value) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch (_) {}
  data[cursorKey(endpoint, port)] = value;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (_) {}
}

function now() {
  return Date.now();
}

function textOf(buf) {
  return buf.toString("utf8").replace(/[\r\n]+$/, "");
}

// ───────────────────────────── CacheSpool ─────────────────────────────────
// host 侧缓存落盘：每个 capture 一个目录，JSONL 分片。
// 只用于本地检索/read 的持久化；不参与远端协议。
class CacheSpool {
  constructor(opts = {}) {
    this.dir = opts.dir;
    this.maxFileBytes = opts.maxFileBytes || 64 * 1024 * 1024;
    this.maxFiles = opts.maxFiles || 8;
    this.maxLoadBytes = opts.maxLoadBytes || 64 * 1024 * 1024;
    this.file = null;
    this.size = 0;
    this.stream = null;
    this.pending = [];
    this.pendingBytes = 0;
    this.flushTimer = null;
    this.seq = 0;
  }

  _files() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((n) => n.startsWith("entries-") && n.endsWith(".jsonl"))
        .sort();
    } catch (_) {
      return [];
    }
  }

  loadEntries() {
    fs.mkdirSync(this.dir, { recursive: true });
    const files = this._files();
    const out = [];
    let remaining = this.maxLoadBytes;
    for (let i = files.length - 1; i >= 0 && remaining > 0; i -= 1) {
      const fp = path.join(this.dir, files[i]);
      let text;
      try {
        text = fs.readFileSync(fp, "utf8");
      } catch (_) {
        continue;
      }
      if (text.length > remaining) text = text.slice(text.length - remaining);
      remaining -= text.length;
      const lines = text.split("\n");
      if (lines.length && lines[0] && i > 0) lines.shift(); // 可能截断首行
      for (const line of lines) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          out.push({
            seq: e.seq,
            ts: e.ts,
            dir: e.dir,
            offset: e.offset,
            bytes: Buffer.from(e.b64, "base64"),
          });
        } catch (_) {}
      }
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  _openStream() {
    const idx = String(this._files().length + 1).padStart(6, "0");
    this.file = path.join(this.dir, `entries-${idx}.jsonl`);
    this.stream = fs.createWriteStream(this.file, { flags: "a" });
    try {
      this.size = fs.statSync(this.file).size;
    } catch (_) {
      this.size = 0;
    }
    this.stream.on("error", () => {});
  }

  append(entry) {
    if (!this.stream) this._openStream();
    const line =
      JSON.stringify({
        seq: entry.seq,
        ts: entry.ts,
        dir: entry.dir,
        offset: entry.offset,
        b64: entry.bytes.toString("base64"),
      }) + "\n";
    this.pending.push(line);
    this.pendingBytes += line.length;
    if (this.pendingBytes >= 64 * 1024) this.flush();
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 200);
      this.flushTimer.unref?.();
    }
    if (this.size + this.pendingBytes >= this.maxFileBytes) {
      this.flush();
      this._rotate();
    }
  }

  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.stream || this.pending.length === 0) return;
    const data = this.pending.join("");
    this.size += Buffer.byteLength(data);
    this.pending = [];
    this.pendingBytes = 0;
    try {
      this.stream.write(data);
    } catch (_) {}
  }

  _rotate() {
    try {
      this.stream?.end();
    } catch (_) {}
    this.stream = null;
    const files = this._files();
    while (files.length > this.maxFiles) {
      const old = files.shift();
      try {
        fs.unlinkSync(path.join(this.dir, old));
      } catch (_) {}
    }
    this._openStream();
  }

  close() {
    this.flush();
    try {
      this.stream?.end();
    } catch (_) {}
    this.stream = null;
  }

  clear() {
    this.close();
    for (const f of this._files()) {
      try {
        fs.unlinkSync(path.join(this.dir, f));
      } catch (_) {}
    }
    this.file = null;
    this.size = 0;
  }
}

// ───────────────────────────── CaptureCache ────────────────────────────────
export class CaptureCache {
  constructor(opts = {}) {
    this.connectionId = opts.connectionId || null;
    this.port = opts.port || null;
    this.ring = new ByteRing(opts.ringBytes || 32 * 1024 * 1024);
    this.baseOffset = opts.startOffset || 0;
    this.ring.resetAt(this.baseOffset);
    this.entries = [];
    this.totalBytes = 0;
    this.maxEntries = opts.maxEntries || 200000;
    this.maxBytes = opts.maxBytes || 128 * 1024 * 1024;
    this.lastSeq = opts.startSeq || 0;
    this.newestOffset = this.baseOffset;
    this.gaps = [];
    this.partial = null;
    this.bytesIn = 0;
    this.waiters = new Set();
    this.spool = null;
  }

  attachSpool(spool) {
    this.spool = spool;
    const loaded = spool.loadEntries();
    if (loaded.length) {
      for (const e of loaded) {
        this.entries.push(e);
        this.totalBytes += e.bytes.length;
        this.lastSeq = Math.max(this.lastSeq, e.seq);
        if (e.dir === "rx") {
          this.newestOffset = Math.max(this.newestOffset, e.offset + e.bytes.length);
        }
      }
      this.entries.sort((a, b) => a.seq - b.seq);
      while (this.totalBytes > this.maxBytes && this.entries.length > 1) {
        const gone = this.entries.shift();
        this.totalBytes -= gone.bytes.length;
      }
      this._rebuildRing();
    }
  }

  get earliestSeq() {
    return this.entries.length ? this.entries[0].seq : null;
  }

  _rebuildRing() {
    const rx = this.entries.filter((e) => e.dir === "rx");
    this.ring.resetAt(rx.length ? rx[0].offset : this.baseOffset);
    for (const e of rx) {
      if (e.offset < this.ring.endOffset) continue;
      if (e.offset > this.ring.endOffset) this.ring.resetAt(e.offset);
      this.ring.push(e.bytes);
    }
  }

  merge(entries) {
    const have = new Set(this.entries.map((e) => e.seq));
    let added = 0;
    for (const e of entries) {
      if (!e || have.has(e.seq)) continue;
      have.add(e.seq);
      this.entries.push({
        seq: e.seq,
        ts: e.ts,
        dir: e.dir,
        offset: e.offset,
        bytes: Buffer.from(e.bytes),
      });
      added += 1;
    }
    if (!added) return 0;
    this.entries.sort((a, b) => a.seq - b.seq);
    this.totalBytes = this.entries.reduce((n, e) => n + e.bytes.length, 0);
    while (
      this.entries.length > this.maxEntries ||
      (this.totalBytes > this.maxBytes && this.entries.length > 1)
    ) {
      const gone = this.entries.shift();
      this.totalBytes -= gone.bytes.length;
    }
    this.lastSeq = Math.max(this.lastSeq, this.entries[this.entries.length - 1].seq);
    for (const e of this.entries) {
      if (e.dir === "rx")
        this.newestOffset = Math.max(this.newestOffset, e.offset + e.bytes.length);
    }
    this._rebuildRing();
    return added;
  }

  resetBase(offset, seq = 0) {
    this.baseOffset = offset;
    this.ring.resetAt(offset);
    this.entries = [];
    this.totalBytes = 0;
    this.lastSeq = seq;
    this.newestOffset = offset;
    this.gaps = [];
    this.partial = null;
  }

  _wake() {
    for (const fn of this.waiters) {
      try {
        fn();
      } catch (_) {}
    }
  }

  waitForData(ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.waiters.delete(finish);
        clearTimeout(timer);
        resolve();
      };
      this.waiters.add(finish);
      const timer = setTimeout(finish, Math.max(0, ms));
      timer.unref?.();
    });
  }

  markGap(offset) {
    const to = Number(offset) || 0;
    this.partial = null;
    if (to > this.newestOffset) {
      this.gaps.push({ from: this.newestOffset, to });
      this.ring.resetAt(to);
      this.newestOffset = to;
    }
    this._wake();
  }

  addBatch(offset, ts, bytes) {
    const chunk = Buffer.from(bytes || Buffer.alloc(0));
    const off = Number(offset) || 0;
    if (chunk.length) {
      if (off > this.ring.endOffset) this.ring.resetAt(off);
      if (off === this.ring.endOffset) this.ring.push(chunk);
      if (off > this.newestOffset) {
        this.gaps.push({ from: this.newestOffset, to: off });
      }
      this.newestOffset = Math.max(this.newestOffset, off + chunk.length);
      this.bytesIn += chunk.length;
    }
    const partialLen = this.partial ? this.partial.length : 0;
    const buf = partialLen ? Buffer.concat([this.partial, chunk]) : chunk;
    const base = off - partialLen;
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0x0a) continue;
      const line = buf.subarray(start, i + 1);
      const seq = this.lastSeq + 1;
      this.entries.push({
        seq,
        ts: Number(ts) || now(),
        dir: "rx",
        offset: base + start,
        bytes: Buffer.from(line),
      });
      this.totalBytes += line.length;
      this.lastSeq = seq;
      if (this.spool) this.spool.append(this.entries[this.entries.length - 1]);
      start = i + 1;
    }
    while (this.totalBytes > this.maxBytes && this.entries.length > 1) {
      const gone = this.entries.shift();
      this.totalBytes -= gone.bytes.length;
    }
    this.partial = start < buf.length ? Buffer.from(buf.subarray(start)) : null;
    this._wake();
  }

  add(seq, offset, ts, bytes, dir = "rx") {
    const n = Number(seq) || this.lastSeq + 1;
    if (n <= this.lastSeq) return false;
    const off = Number(offset) || this.newestOffset;
    if (off > this.newestOffset) {
      this.gaps.push({ from: this.newestOffset, to: off });
      this.ring.resetAt(off);
    }
    if (off >= this.ring.endOffset) {
      if (off > this.ring.endOffset) this.ring.resetAt(off);
      this.ring.push(bytes);
    }
    const entry = {
      seq: n,
      ts: Number(ts) || now(),
      dir,
      offset: off,
      bytes: Buffer.from(bytes),
    };
    this.entries.push(entry);
    this.totalBytes += entry.bytes.length;
    while (
      this.entries.length > this.maxEntries ||
      (this.totalBytes > this.maxBytes && this.entries.length > 1)
    ) {
      const gone = this.entries.shift();
      this.totalBytes -= gone.bytes.length;
    }
    this.lastSeq = n;
    this.newestOffset = Math.max(this.newestOffset, off + entry.bytes.length);
    this.bytesIn += entry.bytes.length;
    if (this.spool) this.spool.append(entry);
    this._wake();
    return true;
  }

  addTx(seq, offset, bytes) {
    const n = Number(seq) || this.lastSeq + 1;
    const entry = {
      seq: n,
      ts: now(),
      dir: "tx",
      offset: Number(offset) || 0,
      bytes: Buffer.from(bytes),
    };
    this.entries.push(entry);
    this.totalBytes += entry.bytes.length;
    this.lastSeq = Math.max(this.lastSeq, n);
    if (this.spool) this.spool.append(entry);
    this._wake();
    return entry;
  }

  readBytes(from, maxBytes) {
    return this.ring.read(from, maxBytes);
  }

  watchData(ms) {
    return this.waitForData(ms);
  }

  _wire(e) {
    return {
      seq: e.seq,
      ts: e.ts,
      ts_source: "ntp",
      dir: e.dir,
      offset: e.offset,
      line: textOf(e.bytes),
      hex: e.bytes.toString("hex"),
      bytes: e.bytes.length,
    };
  }

  query(opts = {}) {
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
    const asc = opts.order !== "desc";
    const contains = opts.contains || null;
    const regex = opts.regex ? new RegExp(opts.regex) : null;
    let list = this.entries;
    if (opts.dir === "rx" || opts.dir === "tx") list = list.filter((e) => e.dir === opts.dir);
    if (Number.isFinite(opts.seq_from)) list = list.filter((e) => e.seq >= opts.seq_from);
    if (Number.isFinite(opts.seq_to)) list = list.filter((e) => e.seq <= opts.seq_to);
    if (Number.isFinite(opts.time_from)) list = list.filter((e) => e.ts >= opts.time_from);
    if (Number.isFinite(opts.time_to)) list = list.filter((e) => e.ts <= opts.time_to);
    if (contains || regex) {
      list = list.filter((e) => {
        const line = textOf(e.bytes);
        if (contains && !line.includes(contains)) return false;
        if (regex && !regex.test(line)) return false;
        return true;
      });
    }
    if (opts.cursor) {
      const c = Number(opts.cursor);
      if (Number.isFinite(c)) list = list.filter((e) => (asc ? e.seq > c : e.seq < c));
    }
    const sorted = asc ? list : [...list].reverse();
    const truncated = sorted.length > limit;
    const picked = sorted.slice(0, limit);
    const earliest = this.entries.length ? this.entries[0].seq : null;
    const latest = this.entries.length ? this.entries[this.entries.length - 1].seq : null;
    return {
      connection_id: this.connectionId,
      transport: "remote",
      source: "host-cache",
      authoritative: false,
      storage: "host-cache",
      entries: picked.map((e) => this._wire(e)),
      count: picked.length,
      truncated,
      next_cursor: truncated && picked.length ? String(picked[picked.length - 1].seq) : null,
      earliest_seq: earliest,
      ram_earliest_seq: earliest,
      ram_latest_seq: latest,
      ram_count: this.entries.length,
      sd_earliest_seq: null,
      sd_latest_seq: null,
      time_source: "ntp",
      time_synced: true,
      time_base_ms: 0,
    };
  }

  stats() {
    const earliest = this.entries.length ? this.entries[0].seq : null;
    const latest = this.entries.length ? this.entries[this.entries.length - 1].seq : null;
    return {
      connection_id: this.connectionId,
      transport: "remote",
      source: "host-cache",
      total: this.entries.length,
      count: this.entries.length,
      earliest_seq: earliest,
      latest_seq: latest,
      ram_earliest_seq: earliest,
      ram_latest_seq: latest,
      ram_count: this.entries.length,
      bytes: this.bytesIn,
      storage: "host-cache",
      gaps: this.gaps,
      ring: {
        bytes: this.ring.capacity,
        used: this.ring.used,
        start_offset: this.ring.startOffset,
        end_offset: this.ring.endOffset,
        dropped_bytes: this.ring.droppedBytes,
      },
    };
  }

  export(opts = {}) {
    const dir = opts.dir === "tx" ? "tx" : opts.dir === "rx" ? "rx" : null;
    let list = this.entries.filter((e) => !dir || e.dir === dir);
    if (Number.isFinite(opts.seq_from)) list = list.filter((e) => e.seq >= opts.seq_from);
    if (Number.isFinite(opts.seq_to)) list = list.filter((e) => e.seq <= opts.seq_to);
    const file =
      opts.path ||
      path.join(
        opts.out_dir ||
          path.join(
            process.env.XDG_CACHE_HOME || path.join(requireHome(), ".cache"),
            "serial-hub-mcp",
            "dumps",
          ),
        `export-${this.port || "port"}-${Date.now()}.log`,
      );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, opts.append ? "a" : "w");
    let bytes = 0;
    let lines = 0;
    for (const e of list) {
      fs.writeSync(fd, e.bytes);
      bytes += e.bytes.length;
      lines += 1;
    }
    fs.closeSync(fd);
    return {
      connection_id: this.connectionId,
      transport: "remote",
      source: "host-cache",
      file,
      bytes,
      lines,
      first_seq: list.length ? list[0].seq : null,
      last_seq: list.length ? list[list.length - 1].seq : null,
      eof: true,
    };
  }

  events() {
    return {
      connection_id: this.connectionId,
      transport: "remote",
      supported: false,
      reason: "当前链路没有设备事件日志，控制面事件不在发送缓存里",
      source: "host-cache",
      events: [],
      count: 0,
      earliest_seq: null,
      latest_seq: null,
      next_cursor: null,
    };
  }

  clear() {
    this.entries = [];
    this.totalBytes = 0;
    this.gaps = [];
    this.lastSeq = 0;
    this.ring.resetAt(this.newestOffset);
    if (this.spool) this.spool.clear();
    return { cleared: true, ram_cleared: true, host_cache: true };
  }

  // LogBackend 兼容（Connection/LogRouter 可能调用）
  addData() {}
  currentPartial() {
    return null;
  }
  unregister() {}
}

function requireHome() {
  return process.env.HOME || ".";
}

// ───────────────────────────── V1Connection ────────────────────────────────
export class V1Connection {
  constructor(config, opts = {}) {
    this.config = config;
    this.id = crypto.randomBytes(6).toString("hex");
    this.endpoint = config.endpoint;
    this.port = config.port_id || null;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.sessionId = null;
    this.slot = null;
    this.captureId = null;
    this.writer = false;
    this.windowBytes = 0;
    this.leaseMs = opts.leaseMs || 30000;
    this.ackInterval = opts.ackInterval || 32768;
    this.pending = new Map();
    this.nextId = 1;
    this.helloWait = null;
    this.cache = new CaptureCache({
      connectionId: this.id,
      port: this.port,
      ringBytes: opts.ringBytes,
      maxEntries: opts.maxEntries,
      maxBytes: opts.maxBytes,
    });
    this.rxCursor = 0;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.dtr = null;
    this.rts = null;
    this.lastError = null;
    this.lastAck = 0;
    this.startedAt = now();
    this.ackTimer = null;
    this.pingTimer = null;
    this.info = null;
    this.mode = null;
    this.stateFile = opts.stateFile || defaultStateFile();
    this.resume = config.v1_resume !== false;
    this.lastPersist = 0;
    this.lastPersistOffset = -1;
    this.closing = false;
    this.hasConnectedOnce = false;
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.reconnects = 0;
    this.lastReconnectAt = null;
    this.lastReconnectScheduledAt = null;
    this.reconnectTimer = null;
    this.reconnectBaseMs = opts.reconnectBaseMs || config.v1_reconnect_base_ms || 500;
    this.reconnectMaxMs = opts.reconnectMaxMs || config.v1_reconnect_max_ms || 30000;
    this.spool = null;
    this.cacheDir =
      opts.cacheDir ||
      process.env.SERIAL_HUB_MCP_V1_CACHE_DIR ||
      path.join(
        process.env.XDG_CACHE_HOME || path.join(requireHome(), ".cache"),
        "serial-hub-mcp",
        "v1-cache",
      );
  }

  async connect() {
    this.closing = false;
    this.hasConnectedOnce = false;
    await this._openSocket();
    try {
      await this._establish();
      this.hasConnectedOnce = true;
    } catch (err) {
      try {
        this.socket?.destroy();
      } catch (_) {}
      this.socket = null;
      throw err;
    }
    return this;
  }

  async _openSocket() {
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.destroy();
      } catch (_) {}
      this.socket = null;
    }
    this.buf = Buffer.alloc(0);
    const socket = await new Promise((resolve, reject) => {
      const s = net.createConnection({
        host: hostOf(this.endpoint),
        port: portOf(this.endpoint),
      });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`连接超时: ${this.endpoint}`));
      }, this.config.connect_timeout_ms || 5000);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      if (this.socket === socket) this._onData(chunk);
    });
    socket.on("error", (err) => {
      if (this.socket === socket) this.lastError = err.message;
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.closing || this.closed) return;
      this._handleDisconnect();
    });
    this.socket = socket;
  }

  async _establish() {
    const hello = await this._hello();
    this.info = hello;
    if (!hello || !hello.caps || hello.caps.push !== true) {
      throw new Error("远端不支持 push（caps.push != true）");
    }
    if (!this.port) {
      const first = Array.isArray(hello.ports) && hello.ports[0];
      if (!first) throw new Error("远端没有可用端口");
      this.port = first.id;
    }
    await this._control("config", {
      port: this.port,
      baud_rate: this.config.baud_rate,
      data_bits: this.config.data_bits,
      stop_bits: this.config.stop_bits,
      parity: this.config.parity,
      flow_control: this.config.flow_control,
    });
    const subscribeParams = {
      port: this.port,
      mode: this.config.v1_mode || "replay+live",
      window_bytes: this.config.v1_window_bytes,
      ack_interval_bytes: this.config.v1_ack_interval_bytes,
      lease_ms: this.leaseMs,
      claim_writer: this.config.claim_writer === true,
    };
    const saved =
      this.hasConnectedOnce && this.captureId
        ? { capture_id: this.captureId, offset: this.cache.newestOffset, seq: this.cache.lastSeq }
        : this.resume
          ? readCursor(this.stateFile, this.endpoint, this.port)
          : null;
    if (saved && saved.capture_id) {
      subscribeParams.from = {
        capture_id: saved.capture_id,
        offset: saved.offset,
        seq: saved.seq,
      };
    }
    let sub;
    try {
      sub = await this._control("subscribe", subscribeParams);
    } catch (err) {
      if (
        subscribeParams.from &&
        (err.code === "capture_expired" || err.code === "capture_not_found")
      ) {
        delete subscribeParams.from;
        sub = await this._control("subscribe", subscribeParams);
      } else {
        throw err;
      }
    }
    const sameCapture = this.captureId != null && Number(sub.capture_id) === Number(this.captureId);
    this.mode = sub.mode;
    this.sessionId = sub.session_id;
    this.slot = sub.port_slot;
    this.captureId = sub.capture_id;
    this.writer = Boolean(sub.writer);
    this.windowBytes = sub.window_bytes;
    const startOffset = sub.start?.offset || 0;
    const startSeq = sub.start?.seq || 0;
    if (!sameCapture) {
      if (this.spool) {
        this.spool.close();
        this.spool = null;
      }
      this.cache.resetBase(startOffset, startSeq);
      this.rxCursor = startOffset;
      const key = Buffer.from(`${this.endpoint}|${this.port}`).toString("base64url").slice(0, 24);
      pruneCaptureDirs(path.join(this.cacheDir, key), 16);
      this.spool = new CacheSpool({ dir: path.join(this.cacheDir, key, String(sub.capture_id)) });
      this.cache.attachSpool(this.spool);
    } else if (this.cache.newestOffset < startOffset) {
      this.cache.markGap(startOffset);
    }
    this.startedAt = now();
    this.lastAck = this.cache.newestOffset;
    this._persistCursor(true);
    this._stopTimers();
    this._startTimers();
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    return this;
  }

  _handleDisconnect() {
    if (this.closing || this.closed) return;
    this._stopTimers();
    this._rejectPending(Object.assign(new Error("连接已断开"), { code: "disconnected" }));
    this._persistCursor(true);
    if (!this.hasConnectedOnce) return;
    if (this.reconnecting) return;
    if (this.config.v1_reconnect === false) {
      this.closed = true;
      return;
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.closed || this.closing) return;
    this.reconnecting = true;
    this.reconnectAttempts += 1;
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** Math.min(this.reconnectAttempts - 1, 6),
    );
    const jitter = Math.floor(Math.random() * Math.min(200, Math.max(1, delay / 2)));
    this.lastReconnectScheduledAt = now();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._reconnect();
    }, delay + jitter);
    this.reconnectTimer.unref?.();
  }

  async _reconnect() {
    if (this.closed || this.closing) return;
    try {
      await this._openSocket();
      await this._establish();
      this.reconnects += 1;
      this.lastReconnectAt = now();
      this.reconnecting = false;
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      try {
        this.socket?.destroy();
      } catch (_) {}
      this.socket = null;
      if (err.code === "unauthorized") {
        this.closed = true;
        this.reconnecting = false;
        return;
      }
      this._scheduleReconnect();
    }
  }

  _stopTimers() {
    if (this.ackTimer) clearInterval(this.ackTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ackTimer = null;
    this.pingTimer = null;
  }

  _startTimers() {
    this.ackTimer = setInterval(() => this._sendAck(), 200);
    this.ackTimer.unref?.();
    this.pingTimer = setInterval(
      () => this._control("ping", { t_ms: now() }).catch(() => {}),
      Math.max(2000, Math.floor(this.leaseMs / 3)),
    );
    this.pingTimer.unref?.();
  }

  _sendAck() {
    if (this.closed || !this.socket) return;
    const off = this.cache.newestOffset;
    if (off <= this.lastAck) return;
    this.lastAck = off;
    try {
      this.socket.write(
        encodeAckFrame({
          slot: this.slot,
          captureId: this.captureId,
          offset: off,
          seq: this.cache.lastSeq,
        }),
      );
    } catch (_) {}
    this._persistCursor(false);
  }

  _persistCursor(force) {
    if (!this.captureId) return;
    const nowMs = now();
    const delta = this.cache.newestOffset - this.lastPersistOffset;
    if (!force && nowMs - this.lastPersist < 1000 && delta < 65536) return;
    this.lastPersist = nowMs;
    this.lastPersistOffset = this.cache.newestOffset;
    writeCursor(this.stateFile, this.endpoint, this.port, {
      capture_id: this.captureId,
      offset: this.cache.newestOffset,
      seq: this.cache.lastSeq,
      updated: nowMs,
    });
  }

  _hello() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("HELLO 超时")), 10000);
      this.helloWait = {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const payload = Buffer.from(
        JSON.stringify({
          token: this.config.token || "",
          client_id: this.config.client_id || "serial-hub-mcp",
        }),
      );
      this.socket.write(encodeFrame(T.HELLO, 0, payload));
    });
  }

  _control(op, params = {}, timeoutMs = 10000) {
    if (this.closed) return Promise.reject(new Error("连接已关闭"));
    if (!this.socket) {
      return Promise.reject(
        Object.assign(new Error(this.reconnecting ? "重连中" : "连接未建立"), {
          code: this.reconnecting ? "reconnecting" : "disconnected",
        }),
      );
    }
    const id = this.nextId++;
    const frame = encodeControl({ id, op, ...params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${op} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  _rejectPending(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const { frames, rest, error } = decodeFrames(this.buf);
    this.buf = rest;
    if (error) {
      this.lastError = "bad_frame";
      return;
    }
    for (const f of frames) this._onFrame(f);
  }

  _onFrame({ type, payload }) {
    if (type === T.HELLO_ACK) {
      let msg;
      try {
        msg = JSON.parse(payload.toString("utf8"));
      } catch (_) {
        return;
      }
      const result = msg.result || msg;
      if (this.helloWait) {
        const w = this.helloWait;
        this.helloWait = null;
        if (msg.ok === false || result.ok === false) {
          w.reject(new Error("HELLO 失败"));
        } else {
          w.resolve(result);
        }
      }
      return;
    }
    if (type === T.CONTROL) {
      let msg;
      try {
        msg = JSON.parse(payload.toString("utf8"));
      } catch (_) {
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else
        p.reject(
          Object.assign(new Error(msg.error?.message || "error"), {
            code: msg.error?.code,
          }),
        );
      return;
    }
    if (type === T.DATA) {
      const p = parseData(payload);
      if (!p) return;
      if (p.flags & FLAG_GAP) {
        this.cache.markGap(p.offset);
        return;
      }
      if (!(p.flags & FLAG_BATCH)) {
        this.lastError = "line_frame";
        return;
      }
      this.cache.addBatch(p.offset, p.ts, p.data);
      this.bytesIn += p.data.length;
      return;
    }
    if (type === T.EVENT) {
      let ev;
      try {
        ev = JSON.parse(payload.toString("utf8"));
      } catch (_) {
        return;
      }
      if (ev.event === "capture_closed" || ev.event === "lease_expired") {
        this.lastError = ev.event;
      }
      if (ev.event === "writer_revoked") this.writer = false;
      return;
    }
    if (type === T.ERROR) {
      let msg;
      try {
        msg = JSON.parse(payload.toString("utf8"));
      } catch (_) {
        msg = { code: "error" };
      }
      this.lastError = msg.message || msg.code || "error";
      if (this.helloWait) {
        const w = this.helloWait;
        this.helloWait = null;
        w.reject(new Error(this.lastError));
      }
    }
  }

  // ── 工具面：read / receive / dump ──
  async read(opts = {}) {
    const from = this.rxCursor;
    const minBytes = opts.minBytes ?? 1;
    const waitMs = opts.waitMs ?? 0;
    const idleMs = opts.idleTimeoutMs ?? 300;
    const budgetMs = opts.budgetMs ?? waitMs;
    const maxBytes = opts.maxBytes ?? READ_CHUNK;
    const match = opts.match || null;
    const deadline = now() + Math.max(waitMs, budgetMs);
    let cursor = from;
    let got = 0;
    let idleDeadline = null;
    for (;;) {
      const slice = this.cache.readBytes(cursor, maxBytes);
      if (slice.data.length > 0) {
        if (match) {
          const abs = this.cache.ring.indexOf(match, slice.from);
          if (abs >= 0) {
            const end = abs + match.length;
            const sub = this.cache.readBytes(slice.from, end - slice.from);
            this.rxCursor = sub.next;
            return this._readResult(slice.from, sub, "match", true);
          }
        }
        got += slice.data.length;
        cursor = slice.next;
        if (!match && got >= minBytes) {
          const all = this.cache.readBytes(from, cursor - from);
          this.rxCursor = all.next;
          return this._readResult(
            all.from,
            all,
            all.next - all.from >= maxBytes ? "max_bytes" : "min_bytes",
          );
        }
        if (idleDeadline == null) idleDeadline = now() + idleMs;
        if (!match) continue;
      }
      const t = now();
      const idleHit = idleDeadline != null && t >= idleDeadline && got > 0;
      if (idleHit || t >= deadline) {
        const all = this.cache.readBytes(from, cursor - from);
        this.rxCursor = all.next;
        return this._readResult(all.from, all, idleHit ? "idle" : "budget");
      }
      const waitUntil = Math.min(deadline, idleDeadline ?? deadline, t + 1000);
      await this.cache.watchData(Math.max(0, waitUntil - t));
    }
  }

  _readResult(from, slice, reason, matched = false) {
    return {
      connection_id: this.id,
      data: slice.data,
      start_offset: from,
      end_offset: slice.next,
      next_offset: slice.next,
      matched,
      timed_out: reason === "idle" || reason === "budget",
      stopped_reason: reason,
      gap: slice.gap,
      gap_bytes: slice.gap ? Math.max(0, from - slice.ringStart) : 0,
      ring_start_offset: slice.ringStart,
      ring_end_offset: slice.ringEnd,
      has_more: slice.ringEnd > slice.next,
      error: null,
    };
  }

  async receive(opts = {}) {
    const start = opts.start || "cursor";
    if (start === "flush") this.rxCursor = this.cache.newestOffset;
    if (opts.reset === "dtr")
      await this.setPulse({ dtr: false, pulseMs: opts.resetPulseMs ?? 100 });
    if (opts.reset === "rts")
      await this.setPulse({ rts: false, pulseMs: opts.resetPulseMs ?? 100 });
    const t0 = now();
    const idleMs = opts.idleTimeoutMs ?? 300;
    const budgetMs = opts.budgetMs ?? 10000;
    const maxBytes = opts.maxBytes || READ_CHUNK;
    const deadline = t0 + budgetMs;
    let cursor = this.rxCursor;
    const chunks = [];
    let bytes = 0;
    let matched = false;
    let stopped = "budget";
    let idleDeadline = null;
    const match = opts.match || null;
    for (;;) {
      const slice = this.cache.readBytes(cursor, Math.min(READ_CHUNK, maxBytes - bytes));
      if (slice.data.length) {
        chunks.push(slice.data);
        bytes += slice.data.length;
        cursor = slice.next;
        if (match) {
          const hay = Buffer.concat(chunks);
          if (hay.includes(match)) {
            matched = true;
            stopped = "match";
            break;
          }
        }
        if (bytes >= maxBytes) {
          stopped = "max_bytes";
          break;
        }
        if (idleDeadline == null) idleDeadline = now() + idleMs;
        continue;
      }
      const t = now();
      if (idleDeadline != null && t >= idleDeadline) {
        stopped = "idle";
        break;
      }
      if (t >= deadline) {
        stopped = "budget";
        break;
      }
      await this.cache.watchData(Math.max(0, Math.min(deadline, idleDeadline ?? deadline) - t));
    }
    this.rxCursor = cursor;
    const data = Buffer.concat(chunks);
    return {
      connection_id: this.id,
      bytes: data.length,
      text: data.toString("utf8"),
      hex: data.toString("hex"),
      start_offset: this.rxCursor - data.length,
      end_offset: this.rxCursor,
      matched,
      timed_out: stopped === "idle" || stopped === "budget",
      stopped_reason: stopped,
      total_time_ms: now() - t0,
    };
  }

  async dumpToFile(opts = {}) {
    const file =
      opts.path ||
      path.join(
        opts.dir ||
          path.join(
            process.env.XDG_CACHE_HOME || path.join(requireHome(), ".cache"),
            "serial-hub-mcp",
            "dumps",
          ),
        `dump-${Date.now()}.log`,
      );
    const t0 = now();
    const budgetMs = opts.budgetMs ?? 5000;
    const idleMs = opts.idleTimeoutMs ?? 300;
    const deadline = t0 + budgetMs;
    const maxBytes = opts.maxBytes || Infinity;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "w");
    let cursor = this.rxCursor;
    let bytes = 0;
    let lines = 0;
    let stopped = "budget";
    let idleDeadline = null;
    for (;;) {
      const slice = this.cache.readBytes(cursor, Math.min(READ_CHUNK, maxBytes - bytes));
      if (slice.data.length) {
        fs.writeSync(fd, slice.data);
        bytes += slice.data.length;
        lines += slice.data.toString("utf8").split("\n").length - 1;
        cursor = slice.next;
        if (bytes >= maxBytes) {
          stopped = "max_bytes";
          break;
        }
        if (idleDeadline == null) idleDeadline = now() + idleMs;
        continue;
      }
      const t = now();
      if (idleDeadline != null && t >= idleDeadline) {
        stopped = "idle";
        break;
      }
      if (t >= deadline) {
        stopped = "budget";
        break;
      }
      await this.cache.watchData(Math.max(0, Math.min(deadline, idleDeadline ?? deadline) - t));
    }
    fs.closeSync(fd);
    this.rxCursor = cursor;
    return {
      connection_id: this.id,
      file,
      bytes,
      lines,
      start_offset: cursor - bytes,
      end_offset: cursor,
      matched: false,
      timed_out: stopped === "idle" || stopped === "budget",
      stopped_reason: stopped,
      total_time_ms: now() - t0,
    };
  }

  async transact(payload, opts = {}) {
    const barrier = this.rxCursor;
    await this.write(payload);
    const r = await this.read({
      match: opts.match,
      minBytes: opts.minBytes ?? 1,
      waitMs: opts.waitMs ?? 5000,
      idleTimeoutMs: opts.idleTimeoutMs ?? opts.waitMs ?? 5000,
      budgetMs: opts.waitMs ?? 5000,
    });
    return { ...r, barrier_offset: barrier };
  }

  async setCache(capBytes) {
    const n = Number(capBytes);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("cap_bytes 必须是正数");
    }
    return this._control("cache_set", { cap_bytes: Math.floor(n) });
  }

  async write(buf) {
    if (!this.writer) throw Object.assign(new Error("not writer"), { code: "not_controller" });
    const data = Buffer.from(buf);
    const res = await this._control("write", {
      port: this.port,
      session_id: this.sessionId,
      data_b64: data.toString("base64"),
    });
    this.bytesOut += data.length;
    if (res && Number.isFinite(res.tx_log_seq)) {
      this.cache.addTx(res.tx_log_seq, res.tx_offset, data);
    }
    return data.length;
  }

  async setLine({ dtr, rts } = {}) {
    const res = await this._control("set_lines", {
      port: this.port,
      session_id: this.sessionId,
      dtr,
      rts,
    });
    if (typeof res?.dtr === "boolean") this.dtr = res.dtr;
    if (typeof res?.rts === "boolean") this.rts = res.rts;
    return { dtr: this.dtr, rts: this.rts };
  }

  async setPulse({ dtr, rts, pulseMs = 100 } = {}) {
    try {
      await this.setLine({ dtr, rts });
    } finally {
      await new Promise((r) => setTimeout(r, Math.max(1, pulseMs)));
      await this.setLine({
        dtr: typeof dtr === "boolean" ? !dtr : undefined,
        rts: typeof rts === "boolean" ? !rts : undefined,
      });
    }
    return { dtr: this.dtr, rts: this.rts };
  }

  async sendBreak(durationMs = 300) {
    return this._control("break", {
      port: this.port,
      session_id: this.sessionId,
      duration_ms: durationMs,
    });
  }

  async flushInput() {
    this.rxCursor = this.cache.newestOffset;
    return { flushed: true };
  }

  status() {
    return {
      connection_id: this.id,
      transport: "remote",
      endpoint: this.endpoint,
      port: this.port,
      open: !this.closed,
      config: this.config,
      capture_id: this.captureId,
      session_id: this.sessionId,
      mode: this.mode,
      reconnecting: this.reconnecting,
      reconnect_attempts: this.reconnectAttempts,
      reconnects: this.reconnects,
      last_reconnect_at: this.lastReconnectAt,
      writer: this.writer,
      bytes_in: this.bytesIn,
      bytes_out: this.bytesOut,
      rx_buffered: Math.max(0, this.cache.newestOffset - this.rxCursor),
      rx_dropped: 0,
      dtr: this.dtr,
      rts: this.rts,
      current_partial_line: null,
      error: this.lastError,
    };
  }

  async close() {
    if (this.closed || this.closing) return;
    this.closing = true;
    this._persistCursor(true);
    try {
      if (this.socket && this.sessionId) {
        await this._control("unsubscribe", { port: this.port, session_id: this.sessionId }, 1000);
      }
    } catch (_) {}
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._stopTimers();
    if (this.spool) {
      this.spool.close();
      this.spool = null;
    }
    try {
      this.socket?.end();
    } catch (_) {}
    this._rejectPending(new Error("连接已关闭"));
  }
}

export class V1LogStore {
  constructor(conn) {
    this.conn = conn;
    this.cache = conn.cache;
    this.id = conn.id;
    this.config = conn.config || {};
  }

  async query(opts = {}) {
    return this.cache.query(opts);
  }

  async stats() {
    return this.cache.stats();
  }

  async clear(_id, opts) {
    return this.cache.clear(opts);
  }

  async export(opts = {}) {
    return this.cache.export(opts);
  }

  async sync(opts = {}) {
    const root =
      opts.out_dir ||
      path.join(
        process.env.SERIAL_HUB_MCP_SYNC_DIR ||
          path.join(
            process.env.XDG_CACHE_HOME || path.join(requireHome(), ".cache"),
            "serial-hub-mcp",
            "remote-sync",
          ),
        String(this.conn.endpoint || this.id).replace(/[^A-Za-z0-9._-]+/g, "_"),
      );
    fs.mkdirSync(root, { recursive: true });
    const statePath = path.join(root, "state.json");
    let state = {};
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
      state = {};
    }
    const dirs = opts.dir === "tx" || opts.dir === "rx" ? [opts.dir] : ["rx", "tx"];
    const files = [];
    for (const dir of dirs) {
      const known = Number.isFinite(Number(state[dir]));
      const file = path.join(root, `${dir}.log`);
      const exported = this.cache.export({
        dir,
        seq_from: known ? Number(state[dir]) + 1 : undefined,
        path: file,
        append: known && fs.existsSync(file),
      });
      if (exported.last_seq != null) state[dir] = exported.last_seq;
      files.push({ dir, ...exported });
    }
    fs.writeFileSync(statePath, JSON.stringify(state));
    return { source: "host-cache", out_dir: root, files, state };
  }

  events() {
    return this.cache.events();
  }

  addData() {}
  addTx() {}
  unregister() {}
  currentPartial() {
    return null;
  }
}

function parseData(payload) {
  if (payload.length < 30) return null;
  return {
    slot: payload[0],
    captureId: Number(payload.readBigUInt64LE(1)),
    seq: payload.readUInt32LE(9),
    offset: Number(payload.readBigUInt64LE(13)),
    ts: Number(payload.readBigUInt64LE(21)),
    flags: payload[29],
    data: payload.subarray(30),
  };
}

function hostOf(endpoint) {
  const m = /^tcp:\/\/([^:/]+):(\d+)$/.exec(String(endpoint));
  if (!m) throw new Error(`endpoint 非法: ${endpoint}`);
  return m[1];
}
function portOf(endpoint) {
  const m = /^tcp:\/\/([^:/]+):(\d+)$/.exec(String(endpoint));
  if (!m) throw new Error(`endpoint 非法: ${endpoint}`);
  return Number(m[2]);
}

export async function openV1Connection(config, opts = {}) {
  const conn = new V1Connection(config, opts);
  await conn.connect();
  return conn;
}

/** 只做 HELLO，拿端口列表后断开。list_ports 用，不订阅。 */
export function probeRemote({ endpoint, token, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: hostOf(endpoint), port: portOf(endpoint) });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接超时: ${endpoint}`));
    }, timeoutMs);
    let buf = Buffer.alloc(0);
    const fail = (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.write(
        encodeFrame(
          T.HELLO,
          0,
          Buffer.from(JSON.stringify({ token: token || "", client_id: "serial-hub-mcp" })),
        ),
      );
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, error } = decodeFrames(buf);
      if (error) return fail(new Error("bad_frame"));
      const hello = frames.find((f) => f.type === T.HELLO_ACK);
      if (!hello) return;
      clearTimeout(timer);
      socket.end();
      try {
        const msg = JSON.parse(hello.payload.toString("utf8"));
        resolve(msg.result || msg);
      } catch (err) {
        reject(err);
      }
    });
  });
}
