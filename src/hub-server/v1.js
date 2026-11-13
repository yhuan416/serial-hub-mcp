// v1.js — 远端串口协议 v1（草案）的 Node 实现。
//
// 设计要点（见 docs/remote-link-protocol-v1.md）：
//   - 会话级 capture：第一个 SUBSCRIBE 创建，最后一个离开后 linger 继续记录；
//   - 二进制帧：HELLO/CONTROL/HELLO_ACK/DATA/ACK/EVENT/ERROR；
//   - 每 session 独立 cursor + 窗口 ACK 流控；
//   - 单 writer（CONFIG/WRITE/SET_LINES/BREAK）；
//   - capture 内 seq/offset 从 0 开始；超出 max_bytes 丢最旧并标 GAP。
//
// 本实现为初版：capture 历史保存在内存（history="ring"），未实现 HISTORY_QUERY/EXPORT。

import crypto from "node:crypto";

import {
  T,
  FLAG_GAP,
  FLAG_BATCH,
  isV1Magic,
  encodeFrame,
  encodeControl,
  encodeHelloAck,
  encodeData,
  encodeAckFrame,
  encodeEvent,
  encodeProtocolError,
  decodeFrames,
} from "../remote/v1_codec.js";

export {
  T,
  FLAG_GAP,
  FLAG_BATCH,
  isV1Magic,
  encodeFrame,
  encodeControl,
  encodeHelloAck,
  encodeData,
  encodeAckFrame,
  encodeEvent,
  encodeProtocolError,
  decodeFrames,
};

const ACK_LEN = 21;

function randomId() {
  return crypto.randomBytes(8).readBigUInt64LE(0) & ((1n << 53n) - 1n);
}

// ───────────────────────────── Capture ─────────────────────────────────────
export class Capture {
  constructor(opts) {
    this.id = Number(randomId());
    this.port = opts.port;
    this.maxBytes = Math.max(1024, opts.maxBytes || 128 * 1024 * 1024);
    this.maxFrame = Math.max(256, opts.maxFrame || 32 * 1024);
    this.lingerMs = Math.max(0, opts.lingerMs ?? 60000);
    this.sessions = new Set();
    this.writerSessionId = null;
    this.rxOffset = 0;
    this.released = 0;
    this.txOffset = 0;
    this.txSeq = 0;
    this.chunks = [];
    this.totalBytes = 0;
    this.paused = false;
    this.pausedFrom = 0;
    this.gapTo = null;
    this.closed = false;
    this.lingerTimer = null;
  }

  get oldestOffset() {
    return this.released;
  }
  get oldestSeq() {
    return 0;
  }
  get newestOffset() {
    return this.rxOffset;
  }
  get newestSeq() {
    return 0;
  }
  get usedBytes() {
    return this.totalBytes;
  }

  onData(chunk) {
    if (this.closed || !chunk || !chunk.length) return;
    if (this.paused) {
      this.rxOffset += chunk.length;
      return;
    }
    this.chunks.push({ offset: this.rxOffset, bytes: Buffer.from(chunk) });
    this.rxOffset += chunk.length;
    this.totalBytes += chunk.length;
    this._evictOverflow();
    this.flushSessions();
  }

  addTx(bytes) {
    const offset = this.txOffset;
    this.txOffset += bytes.length;
    this.txSeq += 1;
    return { offset, seq: this.txSeq };
  }

  /** 从 from 起最多 maxLen 字节。缓存里没有则返回 null。 */
  slice(from, maxLen) {
    if (from < this.released) return null;
    for (const c of this.chunks) {
      const end = c.offset + c.bytes.length;
      if (end <= from) continue;
      if (c.offset > from) return null;
      const start = from - c.offset;
      const n = Math.min(maxLen, c.bytes.length - start);
      if (n <= 0) return null;
      return { offset: from, bytes: c.bytes.subarray(start, start + n) };
    }
    return null;
  }

  noteAck() {
    if (this.sessions.size === 0) return;
    let min = Infinity;
    for (const s of this.sessions) min = Math.min(min, s.ackedOffset);
    if (Number.isFinite(min)) this._dropThrough(min);
  }

  _dropThrough(offset) {
    if (offset <= this.released) return;
    while (this.chunks.length) {
      const c = this.chunks[0];
      const end = c.offset + c.bytes.length;
      if (end <= offset) {
        this.totalBytes -= c.bytes.length;
        this.chunks.shift();
        continue;
      }
      if (c.offset < offset) {
        const cut = offset - c.offset;
        c.bytes = c.bytes.subarray(cut);
        c.offset = offset;
        this.totalBytes -= cut;
      }
      break;
    }
    this.released = offset;
  }

  _evictOverflow() {
    while (this.totalBytes > this.maxBytes && this.chunks.length) {
      const c = this.chunks[0];
      const over = this.totalBytes - this.maxBytes;
      const drop = Math.min(over, c.bytes.length);
      const next = c.offset + drop;
      for (const s of this.sessions) {
        if (s.sentOffset < next) s.forceGap(next);
      }
      this._dropThrough(next);
    }
  }

  attach(session) {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    this.sessions.add(session);
    if (!this.writerSessionId) this.writerSessionId = session.id;
    session.writer = this.writerSessionId === session.id;
    session.flush();
    return { writer: session.writer };
  }

  detach(session) {
    this.sessions.delete(session);
    if (this.writerSessionId === session.id) this.writerSessionId = null;
    if (this.sessions.size === 0) {
      this._dropThrough(session.ackedOffset);
      this._startLinger();
    } else {
      this.noteAck();
    }
  }

  claimWriter(session) {
    if (this.writerSessionId && this.writerSessionId !== session.id) {
      const old = [...this.sessions].find((s) => s.id === this.writerSessionId);
      if (old) {
        old.writer = false;
        old.conn.sendEvent({ event: "writer_revoked", session_id: old.id });
      }
    }
    this.writerSessionId = session.id;
    session.writer = true;
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.pausedFrom = this.rxOffset;
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.rxOffset > this.pausedFrom) this.gapTo = this.rxOffset;
    this.flushSessions();
  }

  flushSessions() {
    for (const s of this.sessions) s.flush();
  }

  _startLinger() {
    if (this.closed || this.lingerMs <= 0) {
      this.close();
      return;
    }
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (this.sessions.size === 0) this.close();
    }, this.lingerMs);
    this.lingerTimer.unref?.();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    this.chunks = [];
    this.totalBytes = 0;
    for (const s of this.sessions) s.onCaptureClosed();
    this.sessions.clear();
    this.onClose?.();
  }

  info() {
    return {
      recording: !this.closed,
      capture_id: this.id,
      port: this.port,
      oldest: { seq: this.oldestSeq, offset: this.oldestOffset },
      newest: { seq: this.newestSeq, offset: this.newestOffset },
      max_bytes: this.maxBytes,
      used_bytes: this.usedBytes,
      linger_ms: this.lingerMs,
      history: "ring",
      sessions: this.sessions.size,
      writer_session_id: this.writerSessionId,
      paused: this.paused,
    };
  }
}

// ───────────────────────────── Session ─────────────────────────────────────
class Session {
  constructor(conn, { id, port, capture, slot, windowBytes, ackIntervalBytes, leaseMs }) {
    this.id = id;
    this.conn = conn;
    this.port = port;
    this.capture = capture;
    this.slot = slot;
    this.windowBytes = windowBytes;
    this.ackIntervalBytes = ackIntervalBytes;
    this.leaseMs = leaseMs;
    this.ackedOffset = 0;
    this.sentOffset = 0;
    this.lastSeq = 0;
    this.paused = false;
    this.writer = false;
    this.lastActivity = Date.now();
    this.closed = false;
  }

  resetCursor(offset, seq) {
    this.ackedOffset = offset;
    this.sentOffset = offset;
    this.lastSeq = seq || 0;
  }

  flush() {
    if (this.closed || this.paused) return;
    const cap = this.capture;
    if (!cap || cap.closed) return;
    // 缺口：capture 已淘汰到 oldest 之后
    if (this.sentOffset < cap.oldestOffset) {
      this._sendGap(cap.oldestOffset, cap.oldestSeq);
    }
    // 暂停造成的缺口
    if (cap.gapTo != null && this.sentOffset < cap.gapTo) {
      this._sendGap(cap.gapTo, cap.newestSeq);
    }
    for (;;) {
      const room = this.windowBytes - (this.sentOffset - this.ackedOffset);
      if (room <= 0) break;
      const slice = cap.slice(this.sentOffset, Math.min(cap.maxFrame, room));
      if (!slice || !slice.bytes.length) break;
      this.conn.send(
        encodeData({
          slot: this.slot,
          captureId: cap.id,
          seq: 0,
          offset: slice.offset,
          ts: Date.now(),
          flags: FLAG_BATCH,
          data: slice.bytes,
        }),
      );
      this.sentOffset = slice.offset + slice.bytes.length;
      this.lastActivity = Date.now();
    }
  }

  forceGap(offset) {
    this._sendGap(offset, 0);
  }

  _sendGap(offset, seq) {
    this.conn.send(
      encodeData({
        slot: this.slot,
        captureId: this.capture.id,
        seq,
        offset,
        ts: Date.now(),
        flags: FLAG_GAP,
        data: Buffer.alloc(0),
      }),
    );
    this.sentOffset = offset;
    this.ackedOffset = Math.max(this.ackedOffset, offset);
    this.lastSeq = seq;
  }

  onAck(offset) {
    if (this.closed) return;
    const v = Math.min(Number(offset) || 0, this.sentOffset);
    if (v > this.ackedOffset) this.ackedOffset = v;
    this.lastActivity = Date.now();
    this.capture?.noteAck();
    this.flush();
  }

  onCaptureClosed() {
    this.closed = true;
    this.conn.sendEvent({ event: "capture_closed", session_id: this.id });
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.capture?.detach(this);
    if (reason) this.conn.sendEvent({ event: reason, session_id: this.id });
  }
}

// ─────────────────────────── V1Connection ──────────────────────────────────
export class V1Connection {
  constructor(server, socket, initialBuf) {
    this.server = server;
    this.socket = socket;
    this.id = crypto.randomBytes(6).toString("hex");
    this.buf = initialBuf && initialBuf.length ? Buffer.from(initialBuf) : Buffer.alloc(0);
    this.authed = !server.token;
    this.sessions = new Map(); // sessionId -> Session
    this.portSlots = new Map(); // port -> slot
    this.nextSlot = 0;
    this.closed = false;
    this.clientId = null;
    this.leaseTimer = setInterval(() => this._checkLease(), 1000);
    this.leaseTimer.unref?.();
    if (this.buf.length) this._drain();
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.leaseTimer);
    for (const s of [...this.sessions.values()]) {
      s.closed = true;
      s.capture?.detach(s);
    }
    this.sessions.clear();
    try {
      this.socket.destroy();
    } catch (_) {}
  }

  send(buf) {
    if (this.closed) return;
    try {
      this.socket.write(buf);
    } catch (_) {
      this.destroy();
    }
  }

  sendEvent(obj) {
    this.send(encodeEvent(obj));
  }

  sendControl(obj) {
    this.send(encodeControl(obj));
  }

  sendError(id, code, message) {
    this.sendControl({ id, ok: false, error: { code, message } });
  }

  onData(chunk) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > this.server.maxFrame * 2) {
      this.send(encodeProtocolError("frame_too_large", "frame exceeds max_frame"));
      this.destroy();
      return;
    }
    this._drain();
  }

  _drain() {
    const { frames, rest, error } = decodeFrames(this.buf);
    this.buf = rest;
    if (error) {
      this.send(encodeProtocolError(error, "bad frame header"));
      this.destroy();
      return;
    }
    for (const f of frames) this._onFrame(f);
  }

  _onFrame({ type, payload }) {
    try {
      if (type === T.HELLO) return this._onHello(payload);
      if (type === T.ACK) return this._onAck(payload);
      if (type === T.CONTROL) return this._onControl(payload);
      this.send(encodeProtocolError("unknown_type", `unknown frame type ${type}`));
    } catch (err) {
      this.send(encodeProtocolError("internal", err.message));
    }
  }

  _onHello(payload) {
    if (this.authed && this.server.token) {
      // 重复 HELLO 允许
    }
    let msg;
    try {
      msg = JSON.parse(payload.toString("utf8"));
    } catch (_) {
      this.send(encodeProtocolError("bad_request", "invalid HELLO json"));
      return this.destroy();
    }
    if (this.server.token) {
      const a = Buffer.from(String(msg.token || ""));
      const b = Buffer.from(String(this.server.token));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        this.send(encodeProtocolError("unauthorized", "bad token"));
        return this.destroy();
      }
    }
    this.authed = true;
    this.clientId = msg.client_id || null;
    this.send(encodeHelloAck({ ok: true, result: this.server.v1HelloResult(this) }));
  }

  _onAck(payload) {
    if (payload.length < ACK_LEN) return;
    const slot = payload[0];
    const captureId = Number(payload.readBigUInt64LE(1));
    const offset = Number(payload.readBigUInt64LE(9));
    const session = this._sessionBySlot(slot);
    if (!session) return;
    if (session.capture.id !== captureId) return;
    session.onAck(offset);
  }

  _sessionBySlot(slot) {
    for (const s of this.sessions.values()) if (s.slot === slot) return s;
    return null;
  }

  _slotFor(port) {
    if (this.portSlots.has(port)) return this.portSlots.get(port);
    const slot = this.nextSlot++ & 0xff;
    this.portSlots.set(port, slot);
    return slot;
  }

  _onControl(payload) {
    let msg;
    try {
      msg = JSON.parse(payload.toString("utf8"));
    } catch (_) {
      this.send(encodeProtocolError("bad_request", "invalid control json"));
      return;
    }
    if (!this.authed) {
      this.sendError(msg.id, "unauthorized", "HELLO required");
      return this.destroy();
    }
    const op = msg.op;
    const handler = {
      ping: () => this._opPing(msg),
      config: () => this._opConfig(msg),
      subscribe: () => this._opSubscribe(msg),
      unsubscribe: () => this._opUnsubscribe(msg),
      pause: () => this._opPause(msg),
      resume: () => this._opResume(msg),
      write: () => this._opWrite(msg),
      set_lines: () => this._opSetLines(msg),
      break: () => this._opBreak(msg),
      history_info: () => this._opHistoryInfo(msg),
      history_query: () => this._opHistoryQuery(msg),
    }[op];
    if (!handler) return this.sendError(msg.id, "unknown_op", `unknown op: ${op}`);
    Promise.resolve(handler()).catch((err) => {
      this.sendError(msg.id, err.code || "internal", err.message || String(err));
    });
  }

  _sessionOf(msg) {
    if (msg.session_id) {
      const s = this.sessions.get(String(msg.session_id));
      if (s) return s;
    }
    return null;
  }

  _needWriter(session) {
    if (!session) throw Object.assign(new Error("session not found"), { code: "bad_request" });
    if (!session.writer) throw Object.assign(new Error("not writer"), { code: "not_controller" });
  }

  async _opPing(msg) {
    this.sendControl({
      id: msg.id,
      ok: true,
      result: { t_ms: msg.t_ms ?? Date.now(), device_tick_ms: Date.now() - this.server.startedAt },
    });
  }

  async _opConfig(msg) {
    const session = this._sessionOf(msg);
    if (session) this._needWriter(session);
    const st = await this.server.manager.openPort(msg.port, {
      baud_rate: msg.baud_rate,
      data_bits: msg.data_bits,
      stop_bits: msg.stop_bits,
      parity: msg.parity,
      flow_control: msg.flow_control,
    });
    this.sendControl({
      id: msg.id,
      ok: true,
      result: { port: st.id, applied: { ...st.settings } },
    });
  }

  async _opSubscribe(msg) {
    const portRef = msg.port;
    const st = await this.server.manager.openPort(portRef);
    let cap = st.capture;
    if (!cap || cap.closed) {
      cap = new Capture({
        port: st.id,
        maxBytes: this.server.captureMaxBytes,
        lingerMs: this.server.captureLingerMs,
        maxFrame: Math.min(this.server.maxFrame || 32 * 1024, 32 * 1024),
      });
      cap.onClose = () => {
        if (st.capture === cap) st.capture = null;
      };
      st.capture = cap;
    }

    const from = msg.from || null;
    let mode = "new";
    let startOffset = 0;
    let startSeq = 0;
    if (from && Number.isFinite(Number(from.capture_id))) {
      if (Number(from.capture_id) !== cap.id) {
        throw Object.assign(new Error("capture not found/expired"), { code: "capture_expired" });
      }
      if (Number.isFinite(Number(from.offset))) startOffset = Number(from.offset);
      if (Number.isFinite(Number(from.seq))) startSeq = Number(from.seq);
      if (startOffset < cap.oldestOffset) {
        mode = "gap";
        startOffset = cap.oldestOffset;
        startSeq = cap.oldestSeq;
      } else {
        mode = "resume";
      }
    } else if (cap.sessions.size > 0) {
      // 已有 capture 但未指定 from：只接实时流
      mode = "resume";
      startOffset = cap.rxOffset;
      startSeq = cap.seq;
    }
    if (msg.mode === "live") {
      startOffset = cap.rxOffset;
      startSeq = cap.seq;
      if (mode === "new") mode = "resume";
    }

    const windowCap = this.server.v1MaxWindowBytes;
    const windowBytes = Math.min(
      Math.max(Number(msg.window_bytes) || this.server.v1WindowBytes, 4096),
      windowCap,
    );
    const session = new Session(this, {
      id: crypto.randomBytes(6).toString("hex"),
      port: st.id,
      capture: cap,
      slot: this._slotFor(st.id),
      windowBytes,
      ackIntervalBytes: Number(msg.ack_interval_bytes) || 32768,
      leaseMs: Number(msg.lease_ms) || this.server.v1LeaseMs,
    });
    session.resetCursor(startOffset, startSeq);
    this.sessions.set(session.id, session);
    cap.attach(session);
    if (msg.claim_writer) cap.claimWriter(session);
    this.sendControl({
      id: msg.id,
      ok: true,
      result: {
        session_id: session.id,
        port_slot: session.slot,
        capture_id: cap.id,
        mode,
        writer: cap.writerSessionId === session.id,
        start: { seq: startSeq, offset: startOffset },
        oldest: { seq: cap.oldestSeq, offset: cap.oldestOffset },
        newest: { seq: cap.newestSeq, offset: cap.newestOffset },
        window_bytes: session.windowBytes,
        linger_ms: cap.lingerMs,
      },
    });
    session.flush();
  }

  async _opUnsubscribe(msg) {
    const session = this._sessionOf(msg);
    if (session) {
      this.sessions.delete(session.id);
      session.close("unsubscribed");
    }
    this.sendControl({ id: msg.id, ok: true, result: { unsubscribed: Boolean(session) } });
  }

  async _opPause(msg) {
    const session = this._sessionOf(msg);
    if (!session) throw Object.assign(new Error("session not found"), { code: "bad_request" });
    session.paused = true;
    if (session.writer) session.capture.pause();
    this.sendControl({ id: msg.id, ok: true, result: { paused: true } });
  }

  async _opResume(msg) {
    const session = this._sessionOf(msg);
    if (!session) throw Object.assign(new Error("session not found"), { code: "bad_request" });
    session.paused = false;
    if (session.writer) session.capture.resume();
    this.sendControl({ id: msg.id, ok: true, result: { resumed: true } });
    session.flush();
  }

  async _opWrite(msg) {
    const session = this._sessionOf(msg);
    this._needWriter(session);
    const data = Buffer.from(msg.data_b64 || "", "base64");
    const cap = session.capture;
    const dedupe = cap._dedupe || (cap._dedupe = new Map());
    if (msg.op_id && dedupe.has(msg.op_id)) {
      return this.sendControl({
        id: msg.id,
        ok: true,
        result: { ...dedupe.get(msg.op_id), deduped: true },
      });
    }
    await this.server.manager.write(session.port, data);
    const tx = cap.addTx(data);
    const result = {
      bytes_written: data.length,
      tx_offset: tx.offset,
      tx_log_seq: tx.seq,
      deduped: false,
    };
    if (msg.op_id) {
      if (dedupe.size > 128) dedupe.delete(dedupe.keys().next().value);
      dedupe.set(msg.op_id, result);
    }
    this.sendControl({ id: msg.id, ok: true, result });
  }

  async _opSetLines(msg) {
    const session = this._sessionOf(msg);
    this._needWriter(session);
    const r = await this.server.manager.setLines(session.port, { dtr: msg.dtr, rts: msg.rts });
    this.sendControl({ id: msg.id, ok: true, result: r });
  }

  async _opBreak(msg) {
    const session = this._sessionOf(msg);
    this._needWriter(session);
    const r = await this.server.manager.break(session.port, msg.duration_ms ?? 300);
    this.sendControl({ id: msg.id, ok: true, result: r });
  }

  async _opHistoryInfo(msg) {
    const st = this.server.manager.resolve(msg.port);
    if (!st) throw Object.assign(new Error("port not found"), { code: "port_not_found" });
    const cap = st.capture;
    if (!cap || cap.closed) {
      return this.sendControl({
        id: msg.id,
        ok: true,
        result: { recording: false, port: st.id, history: "none" },
      });
    }
    this.sendControl({ id: msg.id, ok: true, result: cap.info() });
  }

  async _opHistoryQuery(msg) {
    const st = this.server.manager.resolve(msg.port);
    if (!st) throw Object.assign(new Error("port not found"), { code: "port_not_found" });
    const cap = st.capture;
    if (msg.capture_id != null && (!cap || cap.closed || Number(msg.capture_id) !== cap.id)) {
      throw Object.assign(new Error("capture expired"), { code: "capture_expired" });
    }
    throw Object.assign(new Error("history unsupported"), { code: "unsupported" });
  }

  _checkLease() {
    if (this.closed) return;
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      if (now - s.lastActivity > s.leaseMs) {
        this.sessions.delete(s.id);
        s.close("lease_expired");
      }
    }
  }
}
