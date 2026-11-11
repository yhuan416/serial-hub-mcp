// 进程内假桥：模拟一台 v0 远端串口设备（TCP + NDJSON），用于端到端测试。
// 只用于测试/开发，不随 npm 包发布（package.json files 不含 test-utils）。

import net from "node:net";

const DEFAULT_CAPS = {
  auth: false,
  has_sd: false,
  ring_bytes: 1024 * 1024,
  max_hold_ms: 10000,
  max_frame: 65536,
  can_set_lines: true,
  can_break: true,
  can_config: true,
  log_filter: ["seq", "time", "dir"],
  log_storage: "raw+index",
  binary_frames: false,
};

export class FakeBridge {
  /**
   * @param {object} [opts]
   * @param {string} [opts.token]
   * @param {(data:Buffer, state:object)=>Buffer|void} [opts.onWrite]
   *   收到 WRITE/TRANSACT 时的行为；返回 Buffer 则作为 RX 数据回灌（缺省回显）。
   * @param {number} [opts.ring_limit]
   */
  constructor(opts = {}) {
    this.token = opts.token ?? null;
    this.maxHoldMs = opts.max_hold_ms ?? 10000;
    this.maxFrame = opts.max_frame ?? 65536;
    this.ringLimit = opts.ring_limit ?? 1024 * 1024;
    this.onWrite = opts.onWrite ?? ((data) => data);
    this.caps = { ...DEFAULT_CAPS, auth: Boolean(this.token), ...(opts.caps || {}) };

    this.server = net.createServer((s) => this._accept(s));
    this.sockets = new Set();
    this.writes = [];
    this.breaks = [];
    this.configs = [];
    this.lastLines = { dtr: null, rts: null };
    this.helloCount = 0;
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    return this.server.address().port;
  }

  get port() {
    const addr = this.server.address();
    return addr ? addr.port : null;
  }

  async stop() {
    for (const s of this.sockets) s.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }

  /** 向所有连接注入 RX 数据（模拟外部串口设备主动发数据）。 */
  pushData(data) {
    for (const s of this.sockets) this._append(s.state, Buffer.from(data));
  }

  _accept(socket) {
    const st = {
      socket,
      buf: "",
      authed: !this.token,
      rxOffset: 0,
      txOffset: 0,
      ring: Buffer.alloc(0),
      ringStart: 0,
      ringDropped: 0,
      waiters: new Set(),
      closed: false,
      logSeq: 0,
      log: [],
      partial: Buffer.alloc(0),
    };
    socket.state = st;
    socket.setEncoding("utf8");
    this.sockets.add(socket);
    socket.on("data", (chunk) => this._onData(st, chunk));
    socket.on("close", () => {
      st.closed = true;
      this._wake(st);
      this.sockets.delete(socket);
    });
    socket.on("error", () => {});
  }

  _onData(st, chunk) {
    st.buf += chunk;
    let idx;
    while ((idx = st.buf.indexOf("\n")) >= 0) {
      const line = st.buf.slice(0, idx).trim();
      st.buf = st.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue;
      }
      this._handle(st, msg).catch((err) => {
        this._error(st, msg && msg.id, "io_error", err.message);
      });
    }
  }

  _reply(st, id, result) {
    if (st.closed) return;
    st.socket.write(JSON.stringify({ id, ok: true, result }) + "\n");
  }

  _error(st, id, code, message) {
    if (st.closed) return;
    st.socket.write(JSON.stringify({ id, ok: false, error: { code, message } }) + "\n");
  }

  _append(st, data) {
    st.ring = Buffer.concat([st.ring, data]);
    st.rxOffset += data.length;
    if (st.ring.length > this.ringLimit) {
      const drop = st.ring.length - this.ringLimit;
      st.ring = Buffer.from(st.ring.subarray(drop));
      st.ringStart += drop;
      st.ringDropped += drop;
    }
    this._logRx(st, data);
    this._wake(st);
  }

  _logRx(st, data) {
    let buf = Buffer.concat([st.partial, data]);
    let start = 0;
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] !== 0x0a) continue;
      let end = i;
      if (i > start && buf[i - 1] === 0x0d) end = i - 1;
      const line = buf.subarray(start, end);
      st.log.push({
        seq: ++st.logSeq,
        ts: Date.now(),
        dir: "rx",
        offset: st.rxOffset - buf.length + start,
        line: line.toString("utf8"),
        hex: line.toString("hex"),
        bytes: line.length,
      });
      start = i + 1;
    }
    st.partial = Buffer.from(buf.subarray(start));
  }

  _logTx(st, data) {
    const seq = ++st.logSeq;
    st.log.push({
      seq,
      ts: Date.now(),
      dir: "tx",
      offset: st.txOffset - data.length,
      line: data.toString("utf8"),
      hex: data.toString("hex"),
      bytes: data.length,
    });
    return seq;
  }

  _wake(st) {
    for (const w of [...st.waiters]) w();
  }

  _wait(st, ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        st.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      st.waiters.add(done);
    });
  }

  _view(st, from, match, maxBytes) {
    const start = Math.min(Math.max(from, st.ringStart), st.rxOffset);
    const gap = from < st.ringStart;
    let buf = st.ring.subarray(start - st.ringStart);
    let matched = false;
    if (match && match.length) {
      const idx = buf.indexOf(match);
      if (idx >= 0) {
        buf = buf.subarray(0, idx + match.length);
        matched = true;
      }
    }
    if (buf.length > maxBytes) buf = buf.subarray(0, maxBytes);
    return { data: Buffer.from(buf), start, end: start + buf.length, gap, matched };
  }

  async _read(st, req) {
    const from = Number.isFinite(req.from_offset) ? req.from_offset : st.rxOffset;
    const match = req.match_b64 ? Buffer.from(req.match_b64, "base64") : null;
    const minBytes = req.min_bytes ?? 1;
    const maxBytes = Math.min(req.max_bytes ?? this.maxFrame, this.maxFrame);
    const requestedWait = req.max_wait_ms ?? 5000;
    const maxWait = Math.min(requestedWait, this.maxHoldMs);
    const idle = Math.min(req.idle_timeout_ms ?? 300, maxWait);
    const budget = Math.min(req.budget_ms ?? maxWait, this.maxHoldMs);
    const limit = Math.min(maxWait, budget);
    const started = Date.now();

    for (;;) {
      const v = this._view(st, from, match, maxBytes);
      if (v.matched) {
        return {
          ...v,
          matched: true,
          stopped_reason: "match",
          hold_clamped: requestedWait > this.maxHoldMs,
        };
      }
      if (!match && v.data.length >= minBytes) {
        return {
          ...v,
          matched: false,
          stopped_reason: v.data.length >= maxBytes ? "max_bytes" : "min_bytes",
          hold_clamped: requestedWait > this.maxHoldMs,
        };
      }
      const elapsed = Date.now() - started;
      if (elapsed >= idle) {
        return {
          ...v,
          matched: false,
          stopped_reason: "idle",
          hold_clamped: requestedWait > this.maxHoldMs,
        };
      }
      if (elapsed >= limit) {
        return {
          ...v,
          matched: false,
          stopped_reason: elapsed >= budget ? "budget" : "idle",
          hold_clamped: requestedWait > this.maxHoldMs,
        };
      }
      await this._wait(st, Math.min(limit - elapsed, idle - elapsed, 100));
    }
  }

  _writeToDevice(st, data) {
    st.txOffset += data.length;
    const txLogSeq = this._logTx(st, data);
    this.writes.push(data);
    const resp = this.onWrite ? this.onWrite(data, st) : data;
    if (resp && resp.length) this._append(st, Buffer.from(resp));
    return { bytes_written: data.length, tx_offset: st.txOffset, tx_log_seq: txLogSeq };
  }

  async _handle(st, msg) {
    const id = msg.id;
    if (msg.op === "HELLO") {
      if (this.token && msg.token !== this.token) {
        this._error(st, id, "unauthorized", "bad token");
        st.socket.end();
        return;
      }
      if (msg.proto !== "v0") {
        this._error(st, id, "bad_request", `unsupported proto: ${msg.proto}`);
        return;
      }
      st.authed = true;
      this.helloCount += 1;
      this._reply(st, id, {
        proto: "v0",
        fw_version: "fake-0.1.0",
        caps: this.caps,
        ports: [{ id: "uart0", kind: "uart" }],
        time: { epoch_ms: Date.now(), synced: true, source: "fake", tick_ms: Date.now() },
      });
      return;
    }

    if (!st.authed) {
      this._error(st, id, "unauthorized", "HELLO required");
      st.socket.end();
      return;
    }

    switch (msg.op) {
      case "CONFIG":
        this.configs.push(msg);
        this._reply(st, id, { port: msg.port || "uart0", applied: msg });
        return;
      case "WRITE": {
        const data = Buffer.from(msg.data_b64 || "", "base64");
        const r = this._writeToDevice(st, data);
        this._reply(st, id, { ...r, deduped: false });
        return;
      }
      case "READ": {
        const r = await this._read(st, msg);
        this._reply(st, id, {
          data_b64: r.data.toString("base64"),
          offset_from: r.start,
          offset_to: r.end,
          next_offset: r.end,
          matched: r.matched,
          stopped_reason: r.stopped_reason,
          gap: r.gap,
          ring_start_offset: st.ringStart,
          ring_end_offset: st.rxOffset,
          hold_clamped: r.hold_clamped,
        });
        return;
      }
      case "TRANSACT": {
        const barrier = st.rxOffset;
        const data = Buffer.from(msg.data_b64 || "", "base64");
        const w = this._writeToDevice(st, data);
        const r = await this._read(st, { ...msg, from_offset: barrier });
        this._reply(st, id, {
          data_b64: r.data.toString("base64"),
          offset_from: r.start,
          offset_to: r.end,
          next_offset: r.end,
          barrier_offset: barrier,
          matched: r.matched,
          stopped_reason: r.stopped_reason,
          gap: r.gap,
          ring_start_offset: st.ringStart,
          ring_end_offset: st.rxOffset,
          hold_clamped: r.hold_clamped,
          tx_offset: w.tx_offset,
          tx_log_seq: w.tx_log_seq,
          deduped: false,
        });
        return;
      }
      case "SET_LINES":
        if (msg.dtr !== undefined) this.lastLines.dtr = Boolean(msg.dtr);
        if (msg.rts !== undefined) this.lastLines.rts = Boolean(msg.rts);
        this._reply(st, id, { ...this.lastLines });
        return;
      case "BREAK":
        this.breaks.push(msg.duration_ms ?? 300);
        this._reply(st, id, { duration_ms: msg.duration_ms ?? 300 });
        return;
      case "PING":
        this._reply(st, id, { t_ms: msg.t_ms, device_tick_ms: Date.now() });
        return;
      case "LOG_STATS":
        this._reply(st, id, {
          capacity_bytes: this.ringLimit,
          used_bytes: st.ring.length,
          earliest_seq: st.log.length ? st.log[0].seq : null,
          latest_seq: st.logSeq,
          ring: {
            bytes: this.ringLimit,
            used: st.ring.length,
            start_offset: st.ringStart,
            end_offset: st.rxOffset,
            dropped_bytes: st.ringDropped,
          },
          time: { synced: true, source: "fake" },
        });
        return;
      case "LOG_QUERY": {
        let entries = st.log;
        if (msg.dir) entries = entries.filter((e) => e.dir === msg.dir);
        if (Number.isFinite(msg.seq_from)) entries = entries.filter((e) => e.seq >= msg.seq_from);
        if (Number.isFinite(msg.seq_to)) entries = entries.filter((e) => e.seq <= msg.seq_to);
        const limit = msg.limit ?? 100;
        const page = entries.slice(0, limit);
        this._reply(st, id, {
          entries: page,
          count: page.length,
          truncated: entries.length > page.length,
          next_cursor: page.length ? String(page[page.length - 1].seq) : null,
          earliest_seq: st.log.length ? st.log[0].seq : null,
          source: "device",
          authoritative: true,
          time_source: "fake",
        });
        return;
      }
      case "LOG_CLEAR":
        st.log = [];
        this._reply(st, id, { cleared: true });
        return;
      case "LOG_EXPORT":
        this._reply(st, id, {
          chunk_b64: "",
          index_b64: "",
          bytes: 0,
          next_cursor: null,
          eof: true,
        });
        return;
      case "CLOSE":
        this._reply(st, id, { port: msg.port || "uart0", closed: true });
        setTimeout(() => st.socket.end(), 10);
        return;
      default:
        this._error(st, id, "unknown_op", `unsupported op: ${msg.op}`);
    }
  }
}
