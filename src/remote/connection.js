// 远端串口连接：把 v0 的 READ/TRANSACT/WRITE/... RPC 映射成与本地 Connection
// 相同的对工具方法面（read/write/transact/receive/dumpToFile/setLine/sendBreak/status/close）。
//
// 与本地 Connection 的差异：
//   - 数据只在调用时按需拉取（READ long-poll），没有常驻 RX 泵；
//   - 游标是设备侧字节偏移 rx_offset，不维护本地大缓冲；
//   - transact 由设备给出 barrier_offset，天然排除 RTT 期间的非响应字节。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRemoteLink } from "../links/remote.js";

const READ_CHUNK = 64 * 1024;
const DUMP_CHUNK = 16 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function filePreview(file) {
  let preview = "";
  let fileBytes = 0;
  try {
    fileBytes = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    if (fileBytes <= 2048) {
      const all = Buffer.alloc(fileBytes);
      if (fileBytes) fs.readSync(fd, all, 0, fileBytes, 0);
      preview = all.toString("utf8");
    } else {
      const headLen = 512;
      const tailLen = 1536;
      const head = Buffer.alloc(headLen);
      const tail = Buffer.alloc(tailLen);
      fs.readSync(fd, head, 0, headLen, 0);
      fs.readSync(fd, tail, 0, tailLen, fileBytes - tailLen);
      preview = `${head.toString("utf8")}\n…(中间省略)…\n${tail.toString("utf8")}`;
    }
    fs.closeSync(fd);
  } catch (_) {
    /* ignore */
  }
  return { preview, fileBytes };
}

/**
 * 建链 + HELLO，并确定起始 rx_offset（从「当前」开始，避免回放历史 ring）。
 * @param {object} config 连接配置
 * @returns {Promise<RemoteConnection>}
 */
export async function openRemoteConnection(config) {
  const { rpc, info } = await createRemoteLink(config);
  const caps = (info && info.caps) || {};

  // 串口参数下发（幂等）。设备明确不支持 CONFIG 时容忍；其它错误直接失败。
  if (caps.can_config !== false) {
    try {
      await rpc.request(
        "CONFIG",
        {
          ...(config.port_id ? { port: config.port_id } : {}),
          baud_rate: config.baud_rate,
          data_bits: config.data_bits,
          stop_bits: config.stop_bits,
          parity: config.parity,
          flow_control: config.flow_control,
        },
        { timeoutMs: config.request_timeout_ms ?? 3000 },
      );
    } catch (err) {
      if (err && (err.code === "unsupported" || err.code === "unknown_op")) {
        /* 设备不支持 CONFIG：保留其默认参数 */
      } else {
        rpc.close();
        throw err;
      }
    }
  }

  let startOffset = 0;
  try {
    const st = await rpc.request("LOG_STATS", config.port_id ? { port: config.port_id } : {}, {
      timeoutMs: config.request_timeout_ms ?? 3000,
    });
    if (st && st.ring && typeof st.ring.end_offset === "number") startOffset = st.ring.end_offset;
  } catch (err) {
    if (err && (err.code === "unsupported" || err.code === "unknown_op")) {
      /* 设备不支持 LOG_STATS：从 0 开始 */
    } else {
      rpc.close();
      throw err;
    }
  }
  return new RemoteConnection(rpc, info, config, startOffset);
}

export class RemoteConnection {
  constructor(rpc, info, config, startOffset = 0) {
    this.rpc = rpc;
    this.info = info || {};
    this.caps = this.info.caps || {};
    this.config = config;
    this.id = crypto.randomUUID();
    this.closed = false;
    this.rxCursor = startOffset;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.dropped = 0;
    this.gaps = 0;
    this.dtr = null;
    this.rts = null;
    this.lastError = null;
    this.maxHoldMs = this.caps.max_hold_ms ?? 10000;
    this.port = config.endpoint;
  }

  _p(extra = {}) {
    const p = { ...extra };
    if (this.config.port_id) p.port = this.config.port_id;
    return p;
  }

  _timeout(ms) {
    return Math.min(Math.max(ms, 1000) + 2000, 60000);
  }

  _applyRead(res) {
    const data = res && res.data_b64 ? Buffer.from(res.data_b64, "base64") : Buffer.alloc(0);
    const prev = this.rxCursor;
    let gapBytes = 0;
    if (res && res.gap) {
      this.gaps += 1;
      const start = Number.isFinite(res.offset_from) ? res.offset_from : prev;
      if (start > prev) gapBytes = start - prev;
      this.dropped += gapBytes;
    }
    if (res && typeof res.next_offset === "number") this.rxCursor = res.next_offset;
    else this.rxCursor = prev + data.length;
    this.bytesIn += data.length;
    return {
      connection_id: this.id,
      data,
      start_offset: res && Number.isFinite(res.offset_from) ? res.offset_from : prev,
      end_offset: res && Number.isFinite(res.offset_to) ? res.offset_to : this.rxCursor,
      next_offset: this.rxCursor,
      matched: Boolean(res && res.matched),
      stopped_reason: res && res.stopped_reason,
      timed_out: Boolean(res && ["idle", "budget", "closed"].includes(res.stopped_reason)),
      gap: Boolean(res && res.gap),
      gap_bytes: gapBytes,
      ring_start_offset: res && res.ring_start_offset,
      ring_end_offset: res && res.ring_end_offset,
      has_more:
        res && Number.isFinite(res.ring_end_offset)
          ? res.ring_end_offset > this.rxCursor
          : undefined,
      error: null,
    };
  }

  async _readOnce({
    match,
    minBytes = 1,
    waitMs = 0,
    idleTimeoutMs = 300,
    budgetMs,
    maxBytes,
  } = {}) {
    const budget = budgetMs ?? Math.max(waitMs, 0);
    const params = this._p({
      from_offset: this.rxCursor,
      min_bytes: minBytes,
      max_wait_ms: waitMs,
      idle_timeout_ms: idleTimeoutMs,
      budget_ms: budget,
      ...(match ? { match_b64: Buffer.from(match).toString("base64") } : {}),
      ...(maxBytes ? { max_bytes: maxBytes } : {}),
    });
    const res = await this.rpc.request("READ", params, {
      timeoutMs: this._timeout(Math.max(waitMs, budget)),
    });
    return this._applyRead(res);
  }

  async read(opts = {}) {
    const r = await this._readOnce({
      match: opts.match,
      minBytes: opts.minBytes ?? 1,
      waitMs: opts.waitMs ?? 0,
      idleTimeoutMs: 300,
      budgetMs: Math.max(opts.waitMs ?? 0, 0),
      maxBytes: opts.maxBytes ?? READ_CHUNK,
    });
    return {
      connection_id: this.id,
      data: r.data,
      start_offset: r.start_offset,
      end_offset: r.end_offset,
      next_offset: r.next_offset,
      matched: r.matched,
      timed_out: r.timed_out,
      stopped_reason: r.stopped_reason,
      gap: r.gap,
      gap_bytes: r.gap_bytes,
      ring_start_offset: r.ring_start_offset,
      ring_end_offset: r.ring_end_offset,
      has_more: r.has_more,
      error: null,
    };
  }

  async transact(payload, opts = {}) {
    const waitMs = opts.waitMs ?? 5000;
    const res = await this.rpc.request(
      "TRANSACT",
      this._p({
        data_b64: Buffer.from(payload).toString("base64"),
        min_bytes: opts.minBytes ?? 1,
        max_wait_ms: waitMs,
        idle_timeout_ms: waitMs,
        budget_ms: waitMs,
        ...(opts.match ? { match_b64: Buffer.from(opts.match).toString("base64") } : {}),
      }),
      { timeoutMs: this._timeout(waitMs) },
    );
    this.bytesOut += Buffer.from(payload).length;
    const r = this._applyRead(res);
    return {
      connection_id: this.id,
      data: r.data,
      start_offset: r.start_offset,
      end_offset: r.end_offset,
      next_offset: r.next_offset,
      matched: r.matched,
      timed_out: r.timed_out,
      stopped_reason: r.stopped_reason,
      gap: r.gap,
      gap_bytes: r.gap_bytes,
      ring_start_offset: r.ring_start_offset,
      ring_end_offset: r.ring_end_offset,
      has_more: r.has_more,
      error: null,
    };
  }

  async write(buf) {
    const res = await this.rpc.request(
      "WRITE",
      this._p({ data_b64: Buffer.from(buf).toString("base64") }),
      { timeoutMs: this._timeout(5000) },
    );
    const n = res && typeof res.bytes_written === "number" ? res.bytes_written : buf.length;
    this.bytesOut += n;
    return n;
  }

  async flushInput() {
    try {
      const res = await this.rpc.request(
        "READ",
        this._p({ from_offset: this.rxCursor, max_wait_ms: 0, budget_ms: 0, max_bytes: 1 }),
        { timeoutMs: this._timeout(1000) },
      );
      if (res && typeof res.ring_end_offset === "number") this.rxCursor = res.ring_end_offset;
      else if (res && typeof res.next_offset === "number") this.rxCursor = res.next_offset;
    } catch (err) {
      this.lastError = err.message;
    }
    return true;
  }

  async receive(opts = {}) {
    const {
      start = "cursor",
      reset = "none",
      resetPulseMs = 100,
      match,
      idleTimeoutMs = 300,
      budgetMs = 10000,
      maxBytes,
    } = opts;
    const t0 = Date.now();
    if (start === "flush") await this.flushInput();

    let resetUsed = null;
    if (reset === "dtr") {
      await this.setPulse({ dtr: false, pulseMs: resetPulseMs });
      resetUsed = "dtr";
    } else if (reset === "rts") {
      await this.setPulse({ rts: false, pulseMs: resetPulseMs });
      resetUsed = "rts";
    }

    const deadline = t0 + budgetMs;
    const chunks = [];
    let total = 0;
    let matched = false;
    let stopReason = "budget";
    let startOffset = this.rxCursor;
    let endOffset = this.rxCursor;
    let gap = false;
    let gapBytes = 0;
    let ringStart = null;
    let ringEnd = null;

    for (;;) {
      const remain = deadline - Date.now();
      if (remain <= 0) {
        stopReason = "budget";
        break;
      }
      const r = await this._readOnce({
        match,
        minBytes: 1,
        waitMs: Math.min(remain, this.maxHoldMs),
        idleTimeoutMs,
        budgetMs: remain,
        maxBytes: maxBytes ? Math.max(1, maxBytes - total) : undefined,
      });
      if (r.gap) gap = true;
      gapBytes += r.gap_bytes || 0;
      if (r.ring_start_offset != null) ringStart = r.ring_start_offset;
      if (r.ring_end_offset != null) ringEnd = r.ring_end_offset;
      if (r.data.length) {
        if (!chunks.length) startOffset = r.start_offset;
        chunks.push(r.data);
        total += r.data.length;
        endOffset = r.end_offset;
      }
      if (r.matched) {
        matched = true;
        stopReason = "match";
        break;
      }
      if (r.stopped_reason === "closed" || r.stopped_reason === "error") {
        stopReason = r.stopped_reason;
        break;
      }
      if (maxBytes && total >= maxBytes) {
        stopReason = "max_bytes";
        break;
      }
      if (r.stopped_reason === "idle") {
        stopReason = "idle";
        break;
      }
      if (r.stopped_reason === "budget") {
        stopReason = "budget";
        break;
      }
    }

    const data = Buffer.concat(chunks);
    const frame = {
      connection_id: this.id,
      bytes: data.length,
      text: data.toString("utf8"),
      hex: data.toString("hex"),
      start_offset: startOffset,
      end_offset: endOffset,
      matched,
      timed_out: ["idle", "budget", "closed"].includes(stopReason),
      stopped_reason: stopReason,
      gap,
      gap_bytes: gapBytes,
      ring_start_offset: ringStart,
      ring_end_offset: ringEnd,
      total_time_ms: Date.now() - t0,
    };
    if (resetUsed) frame.reset = resetUsed;
    return frame;
  }

  async dumpToFile(opts = {}) {
    const { file, flush = false, match, idleTimeoutMs = 300, budgetMs = 5000, maxBytes } = opts;
    const t0 = Date.now();
    const deadline = t0 + budgetMs;
    if (flush) await this.flushInput();

    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch (_) {
      /* ignore */
    }
    const stream = fs.createWriteStream(file);
    let collected = 0;
    let stopReason = "budget";
    let matched = false;
    let gap = false;
    let gapBytes = 0;
    let ringStart = null;
    let ringEnd = null;

    try {
      for (;;) {
        const remain = deadline - Date.now();
        if (remain <= 0) {
          stopReason = "budget";
          break;
        }
        const want = maxBytes ? Math.min(DUMP_CHUNK, maxBytes - collected) : DUMP_CHUNK;
        if (want <= 0) {
          stopReason = "max_bytes";
          break;
        }
        const r = await this._readOnce({
          match,
          minBytes: 1,
          waitMs: Math.min(remain, this.maxHoldMs),
          idleTimeoutMs,
          budgetMs: remain,
          maxBytes: want,
        });
        if (r.gap) gap = true;
        gapBytes += r.gap_bytes || 0;
        if (r.ring_start_offset != null) ringStart = r.ring_start_offset;
        if (r.ring_end_offset != null) ringEnd = r.ring_end_offset;
        if (r.data.length) {
          collected += r.data.length;
          await new Promise((resolve, reject) =>
            stream.write(r.data, (err) => (err ? reject(err) : resolve())),
          );
        }
        if (r.matched) {
          matched = true;
          stopReason = "match";
          break;
        }
        if (r.stopped_reason === "closed" || r.stopped_reason === "error") {
          stopReason = r.stopped_reason;
          break;
        }
        if (maxBytes && collected >= maxBytes) {
          stopReason = "max_bytes";
          break;
        }
        if (r.stopped_reason === "idle") {
          stopReason = "idle";
          break;
        }
        if (r.stopped_reason === "budget") {
          stopReason = "budget";
          break;
        }
      }
    } finally {
      await new Promise((resolve) => stream.end(resolve));
    }

    const { preview, fileBytes } = filePreview(file);
    return {
      path: file,
      bytes: fileBytes,
      matched,
      timed_out: ["idle", "budget", "closed"].includes(stopReason),
      stopped_reason: stopReason,
      gap,
      gap_bytes: gapBytes,
      ring_start_offset: ringStart,
      ring_end_offset: ringEnd,
      total_time_ms: Date.now() - t0,
      preview,
    };
  }

  async setLine({ dtr, rts } = {}) {
    if (this.caps.can_set_lines === false) {
      throw new Error("远端不支持 DTR/RTS（caps.can_set_lines=false）");
    }
    const opts = {};
    if (dtr !== undefined) opts.dtr = Boolean(dtr);
    if (rts !== undefined) opts.rts = Boolean(rts);
    if (Object.keys(opts).length === 0) return { dtr: this.dtr, rts: this.rts };
    await this.rpc.request("SET_LINES", this._p(opts), { timeoutMs: this._timeout(2000) });
    if (dtr !== undefined) this.dtr = Boolean(dtr);
    if (rts !== undefined) this.rts = Boolean(rts);
    return { dtr: this.dtr, rts: this.rts };
  }

  async setPulse({ dtr, rts, pulseMs } = {}) {
    await this.setLine({ dtr, rts });
    if (pulseMs && pulseMs > 0) {
      await sleep(pulseMs);
      const back = {};
      if (dtr !== undefined) back.dtr = !dtr;
      if (rts !== undefined) back.rts = !rts;
      await this.setLine(back);
    }
    return { dtr: this.dtr, rts: this.rts };
  }

  async sendBreak(durationMs) {
    if (this.caps.can_break === false) {
      throw new Error("远端不支持 BREAK（caps.can_break=false）");
    }
    await this.rpc.request("BREAK", this._p({ duration_ms: durationMs }), {
      timeoutMs: this._timeout(durationMs + 1000),
    });
    return { duration_ms: durationMs };
  }

  status() {
    const config = { ...this.config };
    if (config.token) config.token = "***";
    return {
      connection_id: this.id,
      transport: "remote",
      endpoint: this.config.endpoint,
      port: this.config.endpoint,
      open: !this.closed,
      config,
      bytes_in: this.bytesIn,
      bytes_out: this.bytesOut,
      rx_offset: this.rxCursor,
      rx_buffered: 0,
      rx_dropped: this.dropped,
      gap_count: this.gaps,
      dtr: this.dtr,
      rts: this.rts,
      current_partial_line: null,
      error: this.lastError,
      remote: {
        proto: this.info.proto,
        fw_version: this.info.fw_version,
        caps: this.caps,
        ports: this.info.ports,
        time: this.info.time,
      },
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.rpc.request("CLOSE", this._p({}), { timeoutMs: 1000 });
    } catch (_) {
      /* 设备可能已断开 */
    }
    this.rpc.close();
  }
}
