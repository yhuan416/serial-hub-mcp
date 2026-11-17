// HostLogStore — hub-mcp 本机持久缓存。
//
// 目标：替换 LogStore 的 JSONL 分片 + 同步全量扫描。数据按行写成二进制 segment，
// SQLite(WAL) 只存 segment/block 索引和统计，不存大块 payload。
//
// 边界：只服务 hub-mcp 本机。远端 hub-server 的 ring/capture 不在这里，仍按它自己的
// 小内存模型迭代。read/receive 继续用现有内存 ring；这里负责 log_query/历史/导出。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";

const MAGIC = Buffer.from("SHL1");
const VERSION = 1;
const SEG_HEADER_FIXED = 20; // magic + version + flags + connLen + createdAt
const REC_HEADER = 36;
const BLOCK_MAX_RECORDS = 1000;
const DEFAULT_SEGMENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_BLOCK_BYTES = 1024 * 1024;
const DEFAULT_RETAIN_BYTES = 512 * 1024 * 1024;
const DEFAULT_RETAIN_DAYS = 7;
const DEFAULT_FLUSH_MS = 500;
const DEFAULT_MAX_PARTIAL_BYTES = 64 * 1024;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function defaultStoreDir() {
  if (process.env.SERIAL_HUB_MCP_STORE_DIR) return process.env.SERIAL_HUB_MCP_STORE_DIR;
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "serial-hub-mcp", "store");
}

function safeName(v) {
  return String(v).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildSegmentHeader(conn, createdAt) {
  const cb = Buffer.from(conn, "utf8");
  const b = Buffer.alloc(SEG_HEADER_FIXED + cb.length);
  MAGIC.copy(b, 0);
  b.writeUInt16LE(VERSION, 4);
  b.writeUInt16LE(0, 6);
  b.writeUInt32LE(cb.length, 8);
  b.writeBigUInt64LE(BigInt(createdAt), 12);
  cb.copy(b, SEG_HEADER_FIXED);
  return b;
}

function readSegmentHeader(buf) {
  if (buf.length < SEG_HEADER_FIXED) return null;
  if (!buf.subarray(0, 4).equals(MAGIC)) return null;
  const version = buf.readUInt16LE(4);
  if (version !== VERSION) return null;
  const connLen = buf.readUInt32LE(8);
  if (SEG_HEADER_FIXED + connLen > buf.length) return null;
  return {
    dataOff: SEG_HEADER_FIXED + connLen,
    createdAt: Number(buf.readBigUInt64LE(12)),
    conn: buf.subarray(SEG_HEADER_FIXED, SEG_HEADER_FIXED + connLen).toString("utf8"),
  };
}

export class HostLogStore {
  constructor(opts = {}) {
    this.dir = opts.dir === undefined ? defaultStoreDir() : opts.dir;
    if (!this.dir) throw new Error("HostLogStore 需要 dir");
    this.retainBytes =
      opts.retainBytes === undefined ? DEFAULT_RETAIN_BYTES : Number(opts.retainBytes);
    this.retainDays = opts.retainDays === undefined ? DEFAULT_RETAIN_DAYS : Number(opts.retainDays);
    this.segmentBytes = Math.max(1024, opts.segmentBytes ?? DEFAULT_SEGMENT_BYTES);
    this.blockBytes = Math.max(256, opts.blockBytes ?? DEFAULT_BLOCK_BYTES);
    this.flushMs = Math.max(50, opts.flushMs ?? DEFAULT_FLUSH_MS);
    this.maxPartialBytes = Math.max(1024, opts.maxPartialBytes ?? DEFAULT_MAX_PARTIAL_BYTES);
    this.memEntries = 0;
    this.partBytes = this.segmentBytes; // stats 兼容字段
    this.partial = new Map();
    this.active = new Map();
    this.evicted = new Map();
    this.nextSeq = 1;
    this.closed = false;

    fs.mkdirSync(this.dir, { recursive: true });
    this.db = new Database(path.join(this.dir, "store.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this._initSchema();
    this._recover();
    this._timer = setInterval(() => this._flushAll(), this.flushMs);
    this._timer.unref?.();
    this._retainTimer = setInterval(() => this._retainAll(), 60000);
    this._retainTimer.unref?.();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conn TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        first_seq INTEGER NOT NULL DEFAULT 0,
        last_seq INTEGER NOT NULL DEFAULT 0,
        first_ts INTEGER NOT NULL DEFAULT 0,
        last_ts INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0,
        records INTEGER NOT NULL DEFAULT 0,
        sealed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_segments_conn ON segments(conn, id);
      CREATE TABLE IF NOT EXISTS blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        segment_id INTEGER NOT NULL,
        conn TEXT NOT NULL,
        offset INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        first_seq INTEGER NOT NULL,
        last_seq INTEGER NOT NULL,
        first_ts INTEGER NOT NULL,
        last_ts INTEGER NOT NULL,
        records INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_blocks_conn_seq ON blocks(conn, first_seq, last_seq);
      CREATE INDEX IF NOT EXISTS idx_blocks_conn_ts ON blocks(conn, first_ts, last_ts);
    `);
  }

  _knownConns() {
    const conns = new Set();
    for (const row of this.db.prepare("SELECT DISTINCT conn FROM segments").all()) {
      conns.add(row.conn);
    }
    for (const conn of this.active.keys()) conns.add(conn);
    for (const conn of this.partial.keys()) conns.add(conn);
    return [...conns];
  }

  _safe(conn) {
    return safeName(conn);
  }

  _connDir(conn) {
    return path.join(this.dir, this._safe(conn));
  }

  _segmentFiles(conn) {
    try {
      return fs
        .readdirSync(this._connDir(conn))
        .filter((n) => /^seg-\d{6}\.shl$/.test(n))
        .sort();
    } catch (_) {
      return [];
    }
  }

  _openActive(conn) {
    let st = this.active.get(conn);
    if (st) return st;
    const dir = this._connDir(conn);
    fs.mkdirSync(dir, { recursive: true });
    const files = this._segmentFiles(conn);
    const next = files.length ? Number(files[files.length - 1].slice(4, 10)) + 1 : 1;
    const file = path.join(dir, `seg-${String(next).padStart(6, "0")}.shl`);
    const fd = fs.openSync(file, "w+");
    const createdAt = Date.now();
    const header = buildSegmentHeader(conn, createdAt);
    fs.writeSync(fd, header);
    const info = this.db
      .prepare(
        "INSERT INTO segments (conn, path, created_at, bytes, sealed) VALUES (?, ?, ?, ?, 0)",
      )
      .run(conn, file, createdAt, header.length);
    st = {
      id: Number(info.lastInsertRowid),
      conn,
      path: file,
      fd,
      size: header.length,
      createdAt,
      firstSeq: 0,
      lastSeq: 0,
      firstTs: 0,
      lastTs: 0,
      records: 0,
      pending: [],
      pendingBytes: 0,
      blockStartOffset: 0,
      blockFirstSeq: 0,
      blockFirstTs: 0,
      blockRecords: 0,
      blockBytes: 0,
    };
    this.active.set(conn, st);
    return st;
  }

  _appendLine(conn, payload, ts, dir, hadNewline) {
    if (this.closed) return null;
    const st = this._openActive(conn);
    const seq = this.nextSeq++;
    const zero = Buffer.alloc(REC_HEADER);
    zero.writeUInt32LE(payload.length, 0);
    zero.writeUInt32LE(crc32(payload), 4);
    zero.writeBigUInt64LE(BigInt(seq), 8);
    zero.writeBigUInt64LE(BigInt(ts || Date.now()), 16);
    zero.writeBigUInt64LE(BigInt(0), 24);
    zero.writeUInt8(dir === "tx" ? 1 : 0, 32);
    zero.writeUInt8(hadNewline ? 1 : 0, 33);
    const rec = Buffer.concat([zero, payload]);

    if (!st.blockFirstSeq) {
      st.blockStartOffset = st.size + st.pendingBytes;
      st.blockFirstSeq = seq;
      st.blockFirstTs = ts || Date.now();
      st.blockRecords = 0;
      st.blockBytes = 0;
    }
    st.pending.push(rec);
    st.pendingBytes += rec.length;
    st.blockBytes += rec.length;
    st.blockRecords += 1;
    st.records += 1;
    st.lastSeq = seq;
    st.lastTs = ts || Date.now();
    if (!st.firstSeq) {
      st.firstSeq = seq;
      st.firstTs = st.lastTs;
    }
    if (st.pendingBytes >= this.blockBytes || st.blockRecords >= BLOCK_MAX_RECORDS) {
      this._flushConn(conn);
    }
    if (st.size >= this.segmentBytes) this._seal(conn);
    return seq;
  }

  _flushConn(conn) {
    const st = this.active.get(conn);
    if (!st || st.pendingBytes === 0) return;
    const data = Buffer.concat(st.pending);
    const blockOffset = st.blockStartOffset;
    const blockFirstSeq = st.blockFirstSeq;
    const blockFirstTs = st.blockFirstTs;
    const blockRecords = st.blockRecords;
    const lastSeq = st.lastSeq;
    const lastTs = st.lastTs;
    fs.writeSync(st.fd, data);
    st.size += data.length;
    st.pending = [];
    st.pendingBytes = 0;
    st.blockStartOffset = 0;
    st.blockFirstSeq = 0;
    st.blockFirstTs = 0;
    st.blockRecords = 0;
    st.blockBytes = 0;
    if (blockRecords > 0) {
      this.db
        .prepare(
          "INSERT INTO blocks (segment_id, conn, offset, bytes, first_seq, last_seq, first_ts, last_ts, records) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          st.id,
          conn,
          blockOffset,
          data.length,
          blockFirstSeq,
          lastSeq,
          blockFirstTs,
          lastTs,
          blockRecords,
        );
    }
    this.db
      .prepare(
        "UPDATE segments SET first_seq=?, last_seq=?, first_ts=?, last_ts=?, bytes=?, records=? WHERE id=?",
      )
      .run(st.firstSeq, st.lastSeq, st.firstTs, st.lastTs, st.size, st.records, st.id);
  }

  _flushAll() {
    for (const conn of this.active.keys()) this._flushConn(conn);
  }

  _seal(conn) {
    const st = this.active.get(conn);
    if (!st) return;
    this._flushConn(conn);
    try {
      fs.fsyncSync(st.fd);
    } catch (_) {}
    try {
      fs.closeSync(st.fd);
    } catch (_) {}
    this.db.prepare("UPDATE segments SET sealed=1 WHERE id=?").run(st.id);
    this.active.delete(conn);
    this._enforceRetention(conn);
  }

  _readBlock(file, offset, bytes) {
    let fd;
    try {
      fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, offset);
      return n === bytes ? buf : buf.subarray(0, n);
    } catch (_) {
      return null;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch (_) {}
      }
    }
  }

  _entryFromRecord(rec, conn) {
    if (rec.length < REC_HEADER) return null;
    const len = rec.readUInt32LE(0);
    if (rec.length < REC_HEADER + len) return null;
    const payload = rec.subarray(REC_HEADER, REC_HEADER + len);
    const crc = rec.readUInt32LE(4);
    if (len > 0 && crc32(payload) !== crc) return null;
    const seq = Number(rec.readBigUInt64LE(8));
    const ts = Number(rec.readBigUInt64LE(16));
    const dir = rec.readUInt8(32) === 1 ? "tx" : "rx";
    return {
      seq,
      ts,
      conn,
      dir,
      line: payload.toString("utf8").replace(/[\r\n]+$/, ""),
      hex: payload.toString("hex"),
      bytes: payload.length,
    };
  }

  _match(entry, opts) {
    if (!entry) return false;
    if (opts.dir && entry.dir !== opts.dir) return false;
    if (opts.seq_from != null && entry.seq < opts.seq_from) return false;
    if (opts.seq_to != null && entry.seq > opts.seq_to) return false;
    if (opts.time_from != null && entry.ts < opts.time_from) return false;
    if (opts.time_to != null && entry.ts > opts.time_to) return false;
    if (opts.contains && !entry.line.includes(opts.contains)) return false;
    if (opts.regex && !opts.regex.test(entry.line)) return false;
    return true;
  }

  async query(opts = {}) {
    this._flushAll();
    const connection_id = opts.connection_id || null;
    const limit = Math.max(1, Number(opts.limit) || 100);
    const order = opts.order === "desc" ? "desc" : "asc";
    const regex = opts.regex ? new RegExp(opts.regex) : null;
    const filter = { ...opts, regex };
    const params = [];
    const where = [];
    if (connection_id) {
      where.push("b.conn = ?");
      params.push(connection_id);
    }
    if (opts.seq_from != null) {
      where.push("b.last_seq >= ?");
      params.push(opts.seq_from);
    }
    if (opts.seq_to != null) {
      where.push("b.first_seq <= ?");
      params.push(opts.seq_to);
    }
    if (opts.time_from != null) {
      where.push("b.last_ts >= ?");
      params.push(opts.time_from);
    }
    if (opts.time_to != null) {
      where.push("b.first_ts <= ?");
      params.push(opts.time_to);
    }
    const sql =
      `SELECT b.*, s.path FROM blocks b JOIN segments s ON s.id = b.segment_id` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY b.first_seq ${order === "desc" ? "DESC" : "ASC"}`;
    const rows = this.db.prepare(sql).all(...params);
    let count = 0;
    const page = [];
    const all = [];
    for (const row of rows) {
      const buf = this._readBlock(row.path, row.offset, row.bytes);
      if (!buf) continue;
      let pos = 0;
      const records = [];
      while (pos + REC_HEADER <= buf.length) {
        const len = buf.readUInt32LE(pos);
        const total = REC_HEADER + len;
        if (pos + total > buf.length) break;
        const entry = this._entryFromRecord(buf.subarray(pos, pos + total), row.conn);
        pos += total;
        if (entry) records.push(entry);
      }
      if (!connection_id) {
        for (const entry of records) {
          if (!this._match(entry, filter)) continue;
          count += 1;
          all.push(entry);
        }
        continue;
      }
      if (order === "desc") records.reverse();
      for (const entry of records) {
        if (!this._match(entry, filter)) continue;
        count += 1;
        if (page.length < limit) page.push(entry);
      }
    }
    if (!connection_id) {
      // 跨连接时 block 可能包含交错 seq，必须按全局 seq 归并
      all.sort((a, b) => a.seq - b.seq);
      if (order === "desc") all.reverse();
      page.push(...all.slice(0, limit));
    }
    const totalRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(records), 0) AS n, MIN(first_seq) AS e, MAX(last_seq) AS l FROM blocks` +
          (connection_id ? " WHERE conn = ?" : ""),
      )
      .get(...(connection_id ? [connection_id] : []));
    const segRows = this.db
      .prepare(
        "SELECT COUNT(*) AS partitions, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(records), 0) AS records FROM segments" +
          (connection_id ? " WHERE conn = ?" : ""),
      )
      .get(...(connection_id ? [connection_id] : []));
    const current = connection_id ? this.currentPartial(connection_id) : null;
    const partials = connection_id
      ? undefined
      : [...this.partial.entries()]
          .map(([conn, p]) => ({
            connection_id: conn,
            text: p.buf.toString("utf8"),
            hex: p.buf.toString("hex"),
            bytes: p.buf.length,
            started_at: p.startedAt,
            updated_at: p.updatedAt,
          }))
          .filter((x) => x.bytes);
    return {
      query: {
        connection_id,
        dir: opts.dir || null,
        seq_from: opts.seq_from ?? null,
        seq_to: opts.seq_to ?? null,
        time_from: opts.time_from ?? null,
        time_to: opts.time_to ?? null,
        contains: opts.contains || null,
        regex: opts.regex || null,
        limit,
        order,
      },
      entries: page,
      count,
      total: Number(totalRow.n) || 0,
      truncated: count > limit,
      earliest_seq: totalRow.e ?? null,
      latest_seq: totalRow.l ?? null,
      retention: {
        evicted_lines: connection_id
          ? this.evicted.get(connection_id) || 0
          : [...this.evicted.values()].reduce((a, b) => a + b, 0),
        disk_partitions: Number(segRows.partitions) || 0,
        disk_bytes: Number(segRows.bytes) || 0,
        retain_bytes: this.retainBytes,
        retain_days: this.retainDays,
        part_bytes: this.segmentBytes,
      },
      source: {
        memory: 0,
        disk_streams: this.active.size,
        disk_dir: this.dir,
        disk_records: Number(segRows.records) || 0,
      },
      current_partial: current,
      ...(connection_id ? {} : { current_partials: partials || [] }),
    };
  }

  stats(connection_id) {
    this._flushAll();
    const rows = this.db
      .prepare(
        `SELECT conn, COUNT(*) AS partitions, COALESCE(SUM(bytes),0) AS bytes,
                COALESCE(SUM(records),0) AS records, MIN(first_ts) AS min_ts, MAX(last_ts) AS max_ts,
                MIN(first_seq) AS earliest_seq, MAX(last_seq) AS latest_seq
         FROM segments` +
          (connection_id ? " WHERE conn = ?" : "") +
          " GROUP BY conn",
      )
      .all(...(connection_id ? [connection_id] : []));
    const byConn = new Map(rows.map((r) => [r.conn, r]));
    const known = connection_id ? [connection_id] : this._knownConns();
    const perConn = known.map((conn) => {
      const r = byConn.get(conn);
      if (!r) {
        return {
          connection_id: conn,
          total: 0,
          memory: 0,
          disk: 0,
          retained_in_memory: false,
          time_range: null,
          dir: this._connDir(conn),
          partitions: 0,
          disk_bytes: 0,
          evicted_lines: this.evicted.get(conn) || 0,
        };
      }
      return {
        connection_id: r.conn,
        total: Number(r.records) || 0,
        memory: 0,
        disk: Number(r.records) || 0,
        retained_in_memory: false,
        time_range: r.min_ts && r.max_ts ? { min: Number(r.min_ts), max: Number(r.max_ts) } : null,
        dir: this._connDir(r.conn),
        partitions: Number(r.partitions) || 0,
        disk_bytes: Number(r.bytes) || 0,
        evicted_lines: this.evicted.get(r.conn) || 0,
        earliest_seq: r.earliest_seq == null ? null : Number(r.earliest_seq),
        latest_seq: r.latest_seq == null ? null : Number(r.latest_seq),
      };
    });
    return {
      log_dir: this.dir,
      mem_entries: 0,
      retain_bytes: this.retainBytes,
      part_bytes: this.segmentBytes,
      active_memory: 0,
      total: perConn.reduce((a, c) => a + c.total, 0),
      connections: perConn,
    };
  }

  clear(connection_id) {
    if (connection_id) {
      this._seal(connection_id);
      const st = this.active.get(connection_id);
      if (st) {
        try {
          fs.closeSync(st.fd);
        } catch (_) {}
        this.active.delete(connection_id);
      }
      const segs = this.db.prepare("SELECT id, path FROM segments WHERE conn=?").all(connection_id);
      for (const s of segs) {
        try {
          fs.unlinkSync(s.path);
        } catch (_) {}
      }
      this.db.prepare("DELETE FROM blocks WHERE conn=?").run(connection_id);
      this.db.prepare("DELETE FROM segments WHERE conn=?").run(connection_id);
      this.partial.delete(connection_id);
      this.evicted.delete(connection_id);
      try {
        fs.rmSync(this._connDir(connection_id), { recursive: true, force: true });
      } catch (_) {}
    } else {
      for (const conn of [...this.active.keys()]) this._seal(conn);
      const segs = this.db.prepare("SELECT id, path FROM segments").all();
      for (const s of segs) {
        try {
          fs.unlinkSync(s.path);
        } catch (_) {}
      }
      this.db.exec("DELETE FROM blocks; DELETE FROM segments;");
      this.partial.clear();
      this.evicted.clear();
      try {
        for (const name of fs.readdirSync(this.dir)) {
          if (name === "store.sqlite" || name.startsWith("store.sqlite-")) continue;
          fs.rmSync(path.join(this.dir, name), { recursive: true, force: true });
        }
      } catch (_) {}
    }
    return this.stats(connection_id);
  }

  addData(conn, buffer, ts) {
    if (!buffer || buffer.length === 0 || this.closed) return;
    const now = ts === undefined ? Date.now() : Number(ts) || Date.now();
    let p = this.partial.get(conn);
    if (!p) p = { buf: Buffer.alloc(0), startedAt: now, updatedAt: now };
    const data = p.buf.length ? Buffer.concat([p.buf, buffer]) : buffer;
    const n = data.length;
    let start = 0;
    for (let i = 0; i < n; i += 1) {
      if (data[i] !== 0x0a) continue;
      // 保留行尾原始字节（\r\n / \n），查询时再剥掉；导出/offset 才不丢换行
      const line = Buffer.from(data.subarray(start, i + 1));
      this._appendLine(conn, line, now, "rx", true);
      start = i + 1;
    }
    const leftover = start >= n ? Buffer.alloc(0) : Buffer.from(data.subarray(start));
    if (leftover.length === 0) this.partial.delete(conn);
    else {
      if (leftover.length > this.maxPartialBytes) {
        // 没有换行的二进制流：不要把 partial 无限攒着，落成一条未终止行
        this._appendLine(conn, leftover, now, "rx", false);
        this.partial.delete(conn);
      } else {
        this.partial.set(conn, {
          buf: leftover,
          startedAt: start > 0 ? now : p.startedAt,
          updatedAt: now,
        });
      }
    }
  }

  addTx(conn, buffer, ts) {
    if (!buffer || buffer.length === 0 || this.closed) return;
    const at = ts === undefined ? Date.now() : Number(ts) || Date.now();
    this._appendLine(conn, Buffer.from(buffer), at, "tx", false);
  }

  unregister(conn) {
    const p = this.partial.get(conn);
    if (p && p.buf.length) this._appendLine(conn, p.buf, Date.now(), "rx", false);
    this.partial.delete(conn);
    this._seal(conn);
  }

  currentPartial(conn) {
    const p = this.partial.get(conn);
    if (!p || p.buf.length === 0) return null;
    return {
      text: p.buf.toString("utf8"),
      hex: p.buf.toString("hex"),
      bytes: p.buf.length,
      started_at: p.startedAt,
      updated_at: p.updatedAt,
    };
  }

  _enforceRetention(conn) {
    const cutoff = this.retainDays > 0 ? Date.now() - this.retainDays * 86400000 : 0;
    const rows = this.db
      .prepare(
        "SELECT id, path, bytes, records, last_ts FROM segments WHERE conn=? AND sealed=1 ORDER BY last_ts ASC, id ASC",
      )
      .all(conn);
    let total = rows.reduce((a, r) => a + Number(r.bytes || 0), 0);
    for (const r of rows) {
      const old = cutoff > 0 && Number(r.last_ts || 0) > 0 && Number(r.last_ts) < cutoff;
      const over = this.retainBytes > 0 && total > this.retainBytes;
      if (!old && !over) continue;
      this.db.prepare("DELETE FROM blocks WHERE segment_id=?").run(r.id);
      this.db.prepare("DELETE FROM segments WHERE id=?").run(r.id);
      try {
        fs.unlinkSync(r.path);
      } catch (_) {}
      total -= Number(r.bytes || 0);
      this.evicted.set(conn, (this.evicted.get(conn) || 0) + Number(r.records || 0));
    }
  }

  _retainAll() {
    for (const conn of this._knownConns()) this._enforceRetention(conn);
  }

  _scanSegment(file, _conn) {
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (_) {
      return null;
    }
    const head = readSegmentHeader(buf);
    if (!head) return null;
    const dataOff = head.dataOff;
    const blocks = [];
    let pos = dataOff;
    let blockStart = dataOff;
    let blockFirstSeq = 0;
    let blockFirstTs = 0;
    let blockLastSeq = 0;
    let blockLastTs = 0;
    let blockRecords = 0;
    let maxSeq = 0;
    let maxTs = 0;
    let records = 0;
    const flushBlock = () => {
      if (blockRecords === 0) return;
      blocks.push({
        offset: blockStart,
        bytes: pos - blockStart,
        first_seq: blockFirstSeq,
        last_seq: blockLastSeq,
        first_ts: blockFirstTs,
        last_ts: blockLastTs,
        records: blockRecords,
      });
      blockRecords = 0;
      blockFirstSeq = 0;
      blockFirstTs = 0;
    };
    while (pos + REC_HEADER <= buf.length) {
      const len = buf.readUInt32LE(pos);
      const total = REC_HEADER + len;
      if (pos + total > buf.length) break;
      const payload = buf.subarray(pos + REC_HEADER, pos + total);
      const crc = buf.readUInt32LE(pos + 4);
      if (len > 0 && crc32(payload) !== crc) break;
      const seq = Number(buf.readBigUInt64LE(pos + 8));
      const ts = Number(buf.readBigUInt64LE(pos + 16));
      const recStart = pos;
      pos += total;
      if (!blockFirstSeq) {
        blockStart = recStart;
        blockFirstSeq = seq;
        blockFirstTs = ts;
      }
      blockLastSeq = seq;
      blockLastTs = ts;
      blockRecords += 1;
      maxSeq = Math.max(maxSeq, seq);
      maxTs = Math.max(maxTs, ts);
      records += 1;
      const bytes = pos - blockStart;
      if (bytes >= this.blockBytes || blockRecords >= BLOCK_MAX_RECORDS) {
        flushBlock();
        blockStart = pos;
      }
    }
    flushBlock();
    return { dataOff, lastGood: pos, blocks, maxSeq, maxTs, records };
  }

  _recoverSegment(row) {
    const scanned = this._scanSegment(row.path, row.conn);
    if (!scanned) {
      this.db.prepare("DELETE FROM blocks WHERE segment_id=?").run(row.id);
      this.db.prepare("DELETE FROM segments WHERE id=?").run(row.id);
      return;
    }
    const stat = fs.statSync(row.path);
    if (stat.size > scanned.lastGood) {
      try {
        fs.truncateSync(row.path, scanned.lastGood);
      } catch (_) {}
    }
    this.db.prepare("DELETE FROM blocks WHERE segment_id=?").run(row.id);
    const ins = this.db.prepare(
      "INSERT INTO blocks (segment_id, conn, offset, bytes, first_seq, last_seq, first_ts, last_ts, records) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const b of scanned.blocks) {
      ins.run(
        row.id,
        row.conn,
        b.offset,
        b.bytes,
        b.first_seq,
        b.last_seq,
        b.first_ts,
        b.last_ts,
        b.records,
      );
    }
    const first = scanned.blocks[0];
    const last = scanned.blocks[scanned.blocks.length - 1];
    this.db
      .prepare(
        "UPDATE segments SET first_seq=?, last_seq=?, first_ts=?, last_ts=?, bytes=?, records=?, sealed=1 WHERE id=?",
      )
      .run(
        first ? first.first_seq : 0,
        last ? last.last_seq : 0,
        first ? first.first_ts : 0,
        last ? last.last_ts : 0,
        scanned.lastGood,
        scanned.records,
        row.id,
      );
  }

  _recover() {
    const rows = this.db.prepare("SELECT * FROM segments WHERE sealed=0").all();
    for (const row of rows) {
      if (!fs.existsSync(row.path)) {
        this.db.prepare("DELETE FROM blocks WHERE segment_id=?").run(row.id);
        this.db.prepare("DELETE FROM segments WHERE id=?").run(row.id);
        continue;
      }
      this._recoverSegment(row);
    }
    // 段文件存在但 SQLite 没有记录（例如索引损坏/丢失）：按目录重新扫描
    try {
      for (const name of fs.readdirSync(this.dir)) {
        const connDir = path.join(this.dir, name);
        let st;
        try {
          st = fs.statSync(connDir);
        } catch (_) {
          continue;
        }
        if (!st.isDirectory()) continue;
        for (const f of this._segmentFiles(name)) {
          const file = path.join(connDir, f);
          const exists = this.db.prepare("SELECT id FROM segments WHERE path=?").get(file);
          if (exists) continue;
          const scanned = this._scanSegment(file, name);
          if (!scanned) continue;
          const createdAt = scanned.blocks[0]?.first_ts || Date.now();
          const info = this.db
            .prepare(
              "INSERT INTO segments (conn, path, created_at, first_seq, last_seq, first_ts, last_ts, bytes, records, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
            )
            .run(
              name,
              file,
              createdAt,
              scanned.blocks[0]?.first_seq || 0,
              scanned.blocks[scanned.blocks.length - 1]?.last_seq || 0,
              scanned.blocks[0]?.first_ts || 0,
              scanned.blocks[scanned.blocks.length - 1]?.last_ts || 0,
              scanned.lastGood,
              scanned.records,
            );
          const ins = this.db.prepare(
            "INSERT INTO blocks (segment_id, conn, offset, bytes, first_seq, last_seq, first_ts, last_ts, records) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          );
          for (const b of scanned.blocks) {
            ins.run(
              Number(info.lastInsertRowid),
              name,
              b.offset,
              b.bytes,
              b.first_seq,
              b.last_seq,
              b.first_ts,
              b.last_ts,
              b.records,
            );
          }
        }
      }
    } catch (_) {}
    const max = this.db.prepare("SELECT COALESCE(MAX(last_seq),0) AS m FROM segments").get().m;
    this.nextSeq = Number(max) + 1;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._timer) clearInterval(this._timer);
    if (this._retainTimer) clearInterval(this._retainTimer);
    for (const conn of [...this.active.keys()]) this._seal(conn);
    try {
      this.db.close();
    } catch (_) {}
  }
}

export { defaultStoreDir, DEFAULT_SEGMENT_BYTES, DEFAULT_RETAIN_BYTES };
