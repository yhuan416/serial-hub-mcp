// LineLog + SegmentStore — x86 版串口日志引擎。
//
// 设计目标（相比 ESP32 桥）：
//   - 多端口、每端口独立 seq / 环形缓冲 / 磁盘分段；
//   - RAM 窗口可配置（默认 20000 条），只给 hub 自己留行；
//   - 磁盘 raw+index 分段（20 字节索引记录）。agent 不通过设备 LOG_* 来查它；
//   - 按容量/天数保留，可 ACK 归档水位。
//
// 索引记录（LE）：offset u64 | seq u32 | tick u32 | len u16 | dir u8 | pad u8

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const INDEX_REC_BYTES = 20;
const DIR_RX = 0;

function newSegmentId(now = Date.now()) {
  const ts = (now & 0xffffffff).toString(16).padStart(8, "0");
  const rand = crypto.randomBytes(2).toString("hex");
  return `${ts}-${rand}`;
}

function parseIndex(buf) {
  const recs = [];
  for (let o = 0; o + INDEX_REC_BYTES <= buf.length; o += INDEX_REC_BYTES) {
    const off = Number(buf.readBigUInt64LE(o));
    const seq = buf.readUInt32LE(o + 8);
    const tick = buf.readUInt32LE(o + 12);
    const len = buf.readUInt16LE(o + 16);
    const dir = buf.readUInt8(o + 18);
    if (len === 0) continue;
    recs.push({ off, seq, tick, len, dir, end: off + len });
  }
  return recs;
}

function encodeIndexRecord(off, seq, tick, len, dir) {
  const b = Buffer.allocUnsafe(INDEX_REC_BYTES);
  b.writeBigUInt64LE(BigInt(off), 0);
  b.writeUInt32LE(seq >>> 0, 8);
  b.writeUInt32LE(tick >>> 0, 12);
  b.writeUInt16LE(len & 0xffff, 16);
  b.writeUInt8(dir ? 1 : 0, 18);
  b.writeUInt8(0, 19);
  return b;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export class SegmentStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir 端口数据目录（<dataDir>/<portId>）
   * @param {number} [opts.segmentBytes] 单段上限，默认 64 MiB
   * @param {number} [opts.retentionBytes] 保留上限，默认 4 GiB
   * @param {number} [opts.retentionDays] 保留天数，默认 7
   * @param {number} [opts.flushMs] 落盘间隔，默认 500ms
   */
  constructor(opts = {}) {
    this.dir = opts.dir;
    this.segDir = path.join(this.dir, "segments");
    this.stateFile = path.join(this.dir, "state.json");
    this.segmentBytes = Math.max(1024 * 1024, opts.segmentBytes ?? 64 * 1024 * 1024);
    this.retentionBytes = Math.max(0, opts.retentionBytes ?? 4 * 1024 * 1024 * 1024);
    this.retentionDays = Math.max(0, opts.retentionDays ?? 7);
    this.flushMs = Math.max(50, opts.flushMs ?? 500);
    this.segments = []; // {id, rawBytes, indexCount, firstSeq, latestSeq, latestRx, latestTx, mtimeS, active, epochBaseMs}
    this.active = null;
    this.pendingRaw = [];
    this.pendingIdx = [];
    this.pendingBytes = 0;
    this.fdRaw = null;
    this.fdIdx = null;
    this.indexCache = new Map(); // segmentId -> records[]
    this.acked = {}; // segmentId -> {rx, tx}
    this.seq = 0;
    this.timer = null;
    this.closed = false;
    ensureDir(this.segDir);
    this._loadState();
    this._loadSegments();
    this._startActiveIfNeeded();
    this.timer = setInterval(() => this.flush(), this.flushMs);
    this.timer.unref?.();
  }

  _loadState() {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      if (s && typeof s === "object") {
        this.acked = s.acked && typeof s.acked === "object" ? s.acked : {};
        this.seq = Number.isFinite(s.seq) ? s.seq : 0;
      }
    } catch (_) {}
  }

  _saveState() {
    const tmp = `${this.stateFile}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ seq: this.seq, acked: this.acked }));
      fs.renameSync(tmp, this.stateFile);
    } catch (_) {}
  }

  _loadSegments() {
    let names = [];
    try {
      names = fs.readdirSync(this.segDir);
    } catch (_) {
      return;
    }
    const ids = new Set();
    for (const n of names) {
      if (n.endsWith(".raw")) ids.add(n.slice(0, -4));
    }
    for (const id of ids) {
      const rawPath = path.join(this.segDir, `${id}.raw`);
      const idxPath = path.join(this.segDir, `${id}.idx`);
      let rawBytes = 0;
      let indexCount = 0;
      let firstSeq = null;
      let latestSeq = null;
      let latestRx = 0;
      let latestTx = 0;
      let mtimeS = 0;
      let epochBaseMs = 0;
      try {
        const st = fs.statSync(rawPath);
        rawBytes = st.size;
        mtimeS = Math.floor(st.mtimeMs / 1000);
      } catch (_) {}
      try {
        const ib = fs.readFileSync(idxPath);
        const recs = parseIndex(ib);
        indexCount = recs.length;
        if (recs.length) {
          firstSeq = recs[0].seq;
          latestSeq = recs[recs.length - 1].seq;
          epochBaseMs = recs[0].tick;
          for (const r of recs) {
            if (r.dir === DIR_RX) latestRx = Math.max(latestRx, r.seq);
            else latestTx = Math.max(latestTx, r.seq);
          }
        }
      } catch (_) {}
      this.segments.push({
        id,
        rawBytes,
        indexCount,
        firstSeq: firstSeq ?? 0,
        latestSeq: latestSeq ?? 0,
        latestRx,
        latestTx,
        mtimeS,
        active: false,
        epochBaseMs,
      });
      if (Number.isFinite(latestSeq)) this.seq = Math.max(this.seq, latestSeq);
    }
    this.segments.sort((a, b) => {
      if (a.firstSeq !== b.firstSeq) return a.firstSeq - b.firstSeq;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  get activeSegment() {
    return this.active;
  }

  _startActiveIfNeeded() {
    if (this.active && this.fdRaw != null) return;
    const id = newSegmentId();
    const rawPath = path.join(this.segDir, `${id}.raw`);
    const idxPath = path.join(this.segDir, `${id}.idx`);
    this.fdRaw = fs.openSync(rawPath, "a");
    this.fdIdx = fs.openSync(idxPath, "a");
    const seg = {
      id,
      rawBytes: 0,
      indexCount: 0,
      firstSeq: null,
      latestSeq: 0,
      latestRx: 0,
      latestTx: 0,
      mtimeS: Math.floor(Date.now() / 1000),
      active: true,
      epochBaseMs: Date.now(),
    };
    this.segments.push(seg);
    this.active = seg;
    // 让所有历史段标记为非 active
    for (const s of this.segments) if (s !== seg) s.active = false;
    this._safeRotateLocked = false;
    this._enforceRetention();
  }

  /** 追加一条日志记录（rx 一行 / tx 一次写）。 */
  append(entry) {
    if (this.closed) return;
    this._startActiveIfNeeded();
    const seg = this.active;
    const raw = entry.bytes;
    const tick = entry.ts >>> 0;
    const recOff = seg.rawBytes + this.pendingBytes;
    this.pendingRaw.push(raw);
    this.pendingIdx.push(
      encodeIndexRecord(recOff, entry.seq, tick, raw.length, entry.dir === "tx"),
    );
    this.pendingBytes += raw.length;
    if (seg.firstSeq == null) seg.firstSeq = entry.seq;
    seg.latestSeq = entry.seq;
    if (entry.dir === "tx") seg.latestTx = entry.seq;
    else seg.latestRx = entry.seq;
    if (this.pendingBytes >= 64 * 1024) this.flush();
    if (seg.rawBytes + this.pendingBytes >= this.segmentBytes) this._rotate();
  }

  flush() {
    if (this.closed) return;
    if (this.pendingBytes === 0) return;
    const raw = Buffer.concat(this.pendingRaw);
    const idx = Buffer.concat(this.pendingIdx);
    this.pendingRaw = [];
    this.pendingIdx = [];
    this.pendingBytes = 0;
    const seg = this.active;
    try {
      if (this.fdRaw != null) fs.writeSync(this.fdRaw, raw);
      if (this.fdIdx != null) fs.writeSync(this.fdIdx, idx);
      if (seg) {
        seg.rawBytes += raw.length;
        seg.indexCount += idx.length / INDEX_REC_BYTES;
        seg.mtimeS = Math.floor(Date.now() / 1000);
        this.indexCache.delete(seg.id);
      }
    } catch (err) {
      // 落盘失败不阻塞串口读取；统计里会体现 sd_write_errors
      this.writeErrors = (this.writeErrors || 0) + 1;
      this.lastWriteError = err;
      return;
    }
    if (seg && seg.rawBytes >= this.segmentBytes) this._rotate();
    this._saveState();
  }

  _rotate() {
    if (this.closed) return;
    this.flush();
    try {
      if (this.fdRaw != null) fs.closeSync(this.fdRaw);
      if (this.fdIdx != null) fs.closeSync(this.fdIdx);
    } catch (_) {}
    this.fdRaw = null;
    this.fdIdx = null;
    if (this.active) this.active.active = false;
    this.active = null;
    this._startActiveIfNeeded();
  }

  _enforceRetention() {
    if (this.retentionBytes <= 0 && this.retentionDays <= 0) return;
    const nowS = Math.floor(Date.now() / 1000);
    for (;;) {
      const candidates = this.segments.filter((s) => s !== this.active);
      if (candidates.length === 0) break;
      const used = this.segments.reduce((n, s) => n + (s.rawBytes || 0), 0);
      const oldest = candidates[0];
      const tooBig = this.retentionBytes > 0 && used > this.retentionBytes;
      const tooOld =
        this.retentionDays > 0 &&
        oldest.mtimeS > 0 &&
        nowS - oldest.mtimeS > this.retentionDays * 86400;
      if (!tooBig && !tooOld) break;
      this._deleteSegment(oldest.id);
    }
  }

  _deleteSegment(id) {
    const i = this.segments.findIndex((s) => s.id === id);
    if (i < 0) return false;
    if (this.segments[i] === this.active) return false;
    try {
      fs.unlinkSync(path.join(this.segDir, `${id}.raw`));
    } catch (_) {}
    try {
      fs.unlinkSync(path.join(this.segDir, `${id}.idx`));
    } catch (_) {}
    this.segments.splice(i, 1);
    this.indexCache.delete(id);
    delete this.acked[id];
    this._saveState();
    return true;
  }

  clear(segmentId) {
    this.flush();
    if (!segmentId || segmentId === "all" || segmentId === "*") {
      for (const seg of [...this.segments]) {
        if (seg === this.active) continue;
        this._deleteSegment(seg.id);
      }
      // 清空活动段：关闭后删除并新建
      try {
        if (this.fdRaw != null) fs.closeSync(this.fdRaw);
        if (this.fdIdx != null) fs.closeSync(this.fdIdx);
      } catch (_) {}
      this.fdRaw = null;
      this.fdIdx = null;
      const act = this.active;
      if (act) {
        try {
          fs.unlinkSync(path.join(this.segDir, `${act.id}.raw`));
        } catch (_) {}
        try {
          fs.unlinkSync(path.join(this.segDir, `${act.id}.idx`));
        } catch (_) {}
        this.segments = this.segments.filter((s) => s !== act);
        this.indexCache.delete(act.id);
        delete this.acked[act.id];
      }
      this.active = null;
      this.seq = 0;
      this._saveState();
      this._startActiveIfNeeded();
      return { cleared: true, sd_cleared: true, ram_cleared: true, active_cleared: true };
    }
    const ok = this._deleteSegment(String(segmentId));
    return {
      cleared: ok,
      sd_cleared: ok,
      ram_cleared: false,
      active_cleared: false,
      segment: String(segmentId),
    };
  }

  ack(segmentId, dir, seq) {
    const id = String(segmentId);
    const d = dir === "tx" ? "tx" : "rx";
    if (!this.acked[id]) this.acked[id] = {};
    this.acked[id][d] = Math.max(this.acked[id][d] ?? 0, Number(seq) || 0);
    this._saveState();
    return { acked: true, segment: id, dir: d, seq: Number(seq) || 0 };
  }

  _ackedOf(seg) {
    const a = this.acked[seg.id] || {};
    const rx = a.rx ?? 0;
    const tx = a.tx ?? 0;
    return {
      acked_rx: rx,
      acked_tx: tx,
      acked: rx >= (seg.latestRx ?? 0) && tx >= (seg.latestTx ?? 0),
    };
  }

  segmentsStats() {
    this.flush();
    const nowS = Math.floor(Date.now() / 1000);
    return this.segments.map((s) => ({
      id: s.id,
      raw_bytes: s.rawBytes,
      index_count: s.indexCount,
      first_seq: s.firstSeq ?? 0,
      latest_seq: s.latestSeq ?? 0,
      latest_rx: s.latestRx ?? 0,
      latest_tx: s.latestTx ?? 0,
      ...this._ackedOf(s),
      epoch_base_ms: s.epochBaseMs ?? 0,
      time_synced: true,
      mtime_s: s.mtimeS || nowS,
      active: s === this.active,
    }));
  }

  stats() {
    const segments = this.segmentsStats();
    const used = segments.reduce((n, s) => n + s.raw_bytes, 0);
    const first = segments.find((s) => s.first_seq > 0);
    const last = segments[segments.length - 1];
    return {
      capacity_bytes: this.retentionBytes,
      used_bytes: used,
      earliest_seq: first ? first.first_seq : 0,
      latest_seq: last ? last.latest_seq : 0,
      sd_earliest_seq: first ? first.first_seq : 0,
      sd_latest_seq: last ? last.latest_seq : 0,
      global_latest_seq: last ? last.latest_seq : 0,
      segment: this.active ? this.active.id : null,
      segments,
      sd_write_errors: this.writeErrors || 0,
      sd_broken: false,
    };
  }

  _loadIndex(id) {
    if (this.indexCache.has(id)) return this.indexCache.get(id);
    let recs = [];
    try {
      recs = parseIndex(fs.readFileSync(path.join(this.segDir, `${id}.idx`)));
    } catch (_) {}
    this.indexCache.set(id, recs);
    if (this.indexCache.size > 4) {
      const firstKey = this.indexCache.keys().next().value;
      if (firstKey !== id) this.indexCache.delete(firstKey);
    }
    return recs;
  }

  /** hub 自己的分段导出。agent 不走这条，日志在 MCP host。 */
  export({ segment, dir, seqFrom, seqTo, cursor, maxBytes = 32768 } = {}) {
    this.flush();
    const id = segment || (this.active && this.active.id);
    const seg = this.segments.find((s) => s.id === id);
    if (!seg) return { error: { code: "not_found", message: "segment 不存在" } };
    const wantDir = dir === "tx" ? 1 : dir === "rx" ? 0 : null;
    const all = this._loadIndex(id);
    const recs = wantDir == null ? all : all.filter((r) => r.dir === wantDir);
    const max = Math.min(Math.max(Number(maxBytes) || 32768, 256), 65536);
    let start = Number.isFinite(Number(cursor)) ? Number(cursor) : null;
    if (start == null || start < 0) {
      if (Number.isFinite(seqFrom)) {
        const r = recs.find((x) => x.seq >= seqFrom);
        start = r ? r.off : -1;
      } else {
        start = recs.length ? recs[0].off : -1;
      }
    }
    if (start < 0) {
      return {
        segment: id,
        chunk: Buffer.alloc(0),
        index: Buffer.alloc(0),
        bytes: 0,
        next_cursor: "0",
        eof: true,
        time_base_ms: 0,
        time_synced: true,
      };
    }
    if (start > seg.rawBytes) start = seg.rawBytes;
    const limitSeq = Number.isFinite(seqTo) ? seqTo : null;
    const picked = [];
    let end = start;
    for (const rec of recs) {
      if (rec.off < start) continue;
      if (limitSeq != null && rec.seq > limitSeq) break;
      if (picked.length > 0 && rec.end - start > max) break;
      picked.push(rec);
      end = rec.end;
      if (end - start >= max) break;
    }
    if (picked.length === 0) {
      return {
        segment: id,
        chunk: Buffer.alloc(0),
        index: Buffer.alloc(0),
        bytes: 0,
        next_cursor: String(start),
        eof: true,
        time_base_ms: 0,
        time_synced: true,
      };
    }
    let chunk = Buffer.alloc(0);
    if (end > start) {
      const len = end - start;
      chunk = Buffer.allocUnsafe(len);
      try {
        const fd = fs.openSync(path.join(this.segDir, `${id}.raw`), "r");
        fs.readSync(fd, chunk, 0, len, start);
        fs.closeSync(fd);
      } catch (_) {}
    }
    const parts = [];
    for (const rec of picked) {
      const rel = rec.off - start;
      if (rel < 0 || rel + rec.len > chunk.length) continue;
      parts.push(encodeIndexRecord(rel, rec.seq, rec.tick, rec.len, rec.dir));
    }
    return {
      segment: id,
      chunk,
      index: Buffer.concat(parts),
      bytes: chunk.length,
      next_cursor: String(end),
      eof: end >= seg.rawBytes,
      time_base_ms: 0,
      time_synced: true,
    };
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.flush();
    try {
      if (this.fdRaw != null) fs.closeSync(this.fdRaw);
      if (this.fdIdx != null) fs.closeSync(this.fdIdx);
    } catch (_) {}
    this.fdRaw = null;
    this.fdIdx = null;
    this._saveState();
  }
}

export class LineLog {
  /**
   * @param {object} opts
   * @param {SegmentStore} opts.store
   * @param {number} [opts.ramEntries] RAM 窗口条数，默认 20000
   * @param {number} [opts.maxLineBytes] 单行上限，默认 4096
   */
  constructor(opts) {
    this.store = opts.store;
    this.maxEntries = Math.max(16, opts.ramEntries ?? 20000);
    this.maxLineBytes = Math.max(64, opts.maxLineBytes ?? 4096);
    this.entries = [];
    this.partial = Buffer.alloc(0);
    this.partialStart = 0;
    this.rxOffset = 0;
    this.txOffset = 0;
    this.seq = this.store.seq || 0;
  }

  _push(entry) {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries)
      this.entries.splice(0, this.entries.length - this.maxEntries);
    this.store.append(entry);
  }

  /** 追加 RX 原始字节，按行切分；offset 为该数据块的起始绝对偏移。 */
  pushRx(chunk, offset) {
    if (!chunk || chunk.length === 0) return;
    const start = Number.isFinite(offset) ? offset : this.rxOffset;
    this.rxOffset = start + chunk.length;
    if (this.partial.length === 0) this.partialStart = start;
    this.partial = this.partial.length ? Buffer.concat([this.partial, chunk]) : Buffer.from(chunk);
    for (;;) {
      const idx = this.partial.indexOf(0x0a);
      if (idx < 0) {
        if (this.partial.length > this.maxLineBytes) {
          // 超长行强制切分（不含换行）
          this._emitLine(this.partial.subarray(0, this.maxLineBytes), this.partialStart);
          this.partialStart += this.maxLineBytes;
          this.partial = this.partial.subarray(this.maxLineBytes);
        }
        break;
      }
      // 保留原始换行（含 \r\n）
      const raw = this.partial.subarray(0, idx + 1);
      this._emitLine(raw, this.partialStart);
      const consumed = idx + 1;
      this.partialStart += consumed;
      this.partial = this.partial.subarray(consumed);
    }
  }

  pushTx(chunk, offset) {
    if (!chunk || chunk.length === 0) return 0;
    const start = Number.isFinite(offset) ? offset : this.txOffset;
    this.txOffset = start + chunk.length;
    const seq = this.store.nextSeq();
    const entry = {
      seq,
      ts: Date.now(),
      dir: "tx",
      offset: start,
      bytes: Buffer.from(chunk),
    };
    this._push(entry);
    return seq;
  }

  _emitLine(bytes, offset) {
    const seq = this.store.nextSeq();
    const entry = { seq, ts: Date.now(), dir: "rx", offset, bytes: Buffer.from(bytes) };
    this._push(entry);
  }

  _textOf(buf) {
    return buf.toString("utf8").replace(/[\r\n]+$/, "");
  }

  _entryToWire(e) {
    return {
      seq: e.seq,
      ts: e.ts,
      ts_source: "ntp",
      dir: e.dir,
      offset: e.offset,
      line: this._textOf(e.bytes),
      hex: e.bytes.toString("hex"),
      bytes: e.bytes.length,
    };
  }

  query({ dir, seqFrom, seqTo, limit = 100, order = "asc", cursor } = {}) {
    const max = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const asc = order !== "desc";
    let list = this.entries;
    if (dir === "rx" || dir === "tx") list = list.filter((e) => e.dir === dir);
    if (Number.isFinite(seqFrom)) list = list.filter((e) => e.seq >= seqFrom);
    if (Number.isFinite(seqTo)) list = list.filter((e) => e.seq <= seqTo);
    if (cursor != null && cursor !== "") {
      const c = Number(cursor);
      if (Number.isFinite(c)) {
        list = list.filter((e) => (asc ? e.seq > c : e.seq < c));
      }
    }
    if (!asc) list = [...list].reverse();
    const truncated = list.length > max;
    const picked = list.slice(0, max);
    return {
      entries: picked.map((e) => this._entryToWire(e)),
      truncated,
      next_cursor: truncated && picked.length ? String(picked[picked.length - 1].seq) : null,
      ram_earliest_seq: this.entries.length ? this.entries[0].seq : 0,
      ram_latest_seq: this.entries.length ? this.entries[this.entries.length - 1].seq : 0,
      ram_count: this.entries.length,
    };
  }

  stats() {
    const s = this.store.stats();
    return {
      ...s,
      ram_earliest_seq: this.entries.length ? this.entries[0].seq : 0,
      ram_latest_seq: this.entries.length ? this.entries[this.entries.length - 1].seq : 0,
      ram_count: this.entries.length,
      rx_bytes: this.rxOffset,
      tx_bytes: this.txOffset,
    };
  }

  clear(segmentId) {
    const res = this.store.clear(segmentId);
    if (res.ram_cleared) {
      this.entries = [];
      this.partial = Buffer.alloc(0);
      this.partialStart = 0;
      this.seq = 0;
    }
    return res;
  }
}
