// RemoteLogStore — host-side LogBackend for remote (v0) connections.
//
// It implements the same methods LogRouter/Connection call for local LogStore,
// but stores nothing on the host: queries are proxied to the device's
// authoritative RAM/SD log (LOG_QUERY/LOG_STATS/LOG_CLEAR), and historical
// bulk export is done with LOG_EXPORT into a host file.
//
// The device's SD log is authoritative; `source:"device"`/`authoritative:true`
// are carried through. The host does not mirror remote RX/TX bytes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const INDEX_REC_BYTES = 20; // offset(u64) seq(u32) tick(u32) len(u16) dir(u8) pad
const QUERY_PAGE_MAX = 500;
const QUERY_SCAN_PAGES_MAX = 20;

function firstNumber(...values) {
  for (const v of values) {
    if (Number.isFinite(v)) return v;
  }
  return null;
}

function defaultDumpsDir() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return process.env.SERIAL_HUB_MCP_DUMPS_DIR || path.join(base, "serial-hub-mcp", "dumps");
}

function defaultExportPath(connectionId) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return path.join(
    defaultDumpsDir(),
    `export-${day}-${String(connectionId).slice(0, 8)}-${Date.now()}.log`,
  );
}

function defaultSyncDir() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return process.env.SERIAL_HUB_MCP_SYNC_DIR || path.join(base, "serial-hub-mcp", "remote-sync");
}

function safeName(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch (_) {
    return {};
  }
}

function writeState(file, state) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export class RemoteLogStore {
  /**
   * @param {import("./connection.js").RemoteConnection} conn
   */
  constructor(conn) {
    this.conn = conn;
    this.rpc = conn.rpc;
    this.id = conn.id;
    this.config = conn.config || {};
  }

  _portParams(extra = {}) {
    const p = { ...extra };
    if (this.config.port_id) p.port = this.config.port_id;
    return p;
  }

  // ── Connection 侧接口：远端不落 host 日志 ─────────────────
  addData() {}
  addTx() {}
  unregister() {}
  currentPartial() {
    return null;
  }

  // ── 查询接口 ──────────────────────────────────────────────
  /**
   * Proxy LOG_QUERY. The device keeps a RAM line index; historical data is
   * exported with LOG_EXPORT. contains/regex are filtered locally, so they may
   * scan multiple RAM pages (bounded) rather than only the first page.
   * time_from/time_to are accepted but ignored: the device ts is uptime tick.
   *
   * `order:"desc"` without seq_to/seq_from starts from the newest RAM window
   * and returns newest-first, not the oldest retained window.
   */
  async query(opts = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const order = opts.order === "desc" ? "desc" : "asc";
    const contains = opts.contains || null;
    const regex = opts.regex ? new RegExp(opts.regex) : null;
    const hasFilter = Boolean(contains || regex);
    const seqFrom = Number.isFinite(opts.seq_from) ? opts.seq_from : undefined;
    const seqTo = Number.isFinite(opts.seq_to) ? opts.seq_to : undefined;

    // desc needs the newest seq; content filters need the RAM window bounds.
    const st = order === "desc" || hasFilter ? await this.stats().catch(() => null) : null;
    const ramEarliest = firstNumber(st?.ram_earliest_seq, st?.earliest_seq, seqFrom, 1);
    const ramLatest = firstNumber(st?.ram_latest_seq, st?.latest_seq);
    const sdEarliest = firstNumber(st?.sd_earliest_seq, st?.earliest_seq);
    const sdLatest = firstNumber(st?.sd_latest_seq, st?.latest_seq);

    const matches = [];
    let scanned = 0;
    let pages = 0;
    let truncated = false;
    let scanTruncated = false;
    let nextCursor = null;

    const match = (e) => {
      const line = String(e.line ?? "");
      if (contains && !line.includes(contains)) return false;
      if (regex && !regex.test(line)) return false;
      return true;
    };

    if (!hasFilter) {
      const params = {
        ...(opts.dir ? { dir: opts.dir } : {}),
        ...(opts.cursor ? { cursor: String(opts.cursor) } : {}),
        ...(seqFrom != null ? { seq_from: seqFrom } : {}),
        ...(seqTo != null ? { seq_to: seqTo } : {}),
        limit,
      };
      if (order === "desc") {
        // Cursor is the high bound (exclusive) returned by the previous page.
        const high = opts.cursor ? Number(opts.cursor) - 1 : (seqTo ?? ramLatest);
        if (Number.isFinite(high)) {
          params.seq_to = high;
          params.seq_from = Math.max(ramEarliest ?? 1, high - limit + 1, seqFrom ?? 0);
        }
      }
      const res = await this.rpc.request("LOG_QUERY", this._portParams(params), 15000);
      const entries = Array.isArray(res.entries) ? res.entries.slice() : [];
      if (order === "desc") entries.reverse();
      const oldest = entries.length ? entries[entries.length - 1].seq : null;
      const hasOlder =
        order === "desc" && oldest != null && (ramEarliest == null || oldest > ramEarliest);
      return this._queryResult({
        res,
        entries,
        limit,
        order,
        ramEarliest: firstNumber(res.ram_earliest_seq, res.earliest_seq, ramEarliest),
        ramLatest: firstNumber(res.ram_latest_seq, ramLatest),
        sdEarliest: firstNumber(res.sd_earliest_seq, sdEarliest),
        sdLatest: firstNumber(res.sd_latest_seq, sdLatest),
        scanned: entries.length,
        pages: 1,
        truncated: Boolean(res.truncated) || hasOlder,
        scanTruncated: false,
        nextCursor: order === "desc" ? (hasOlder ? oldest - 1 : null) : (res.next_cursor ?? null),
        opts,
      });
    }

    if (order === "asc") {
      let cursor = opts.cursor ? String(opts.cursor) : undefined;
      let start = seqFrom;
      while (matches.length < limit && pages < QUERY_SCAN_PAGES_MAX) {
        const res = await this.rpc.request(
          "LOG_QUERY",
          this._portParams({
            ...(opts.dir ? { dir: opts.dir } : {}),
            ...(cursor ? { cursor } : start != null ? { seq_from: start } : {}),
            ...(seqTo != null ? { seq_to: seqTo } : {}),
            limit: QUERY_PAGE_MAX,
          }),
          15000,
        );
        pages += 1;
        const entries = Array.isArray(res.entries) ? res.entries : [];
        scanned += entries.length;
        for (const e of entries) {
          if (matches.length >= limit) break;
          if (match(e)) matches.push(e);
        }
        if (matches.length >= limit) {
          truncated = true;
          nextCursor = entries.length ? entries[entries.length - 1].seq : null;
          break;
        }
        if (!res.truncated || !res.next_cursor || entries.length === 0) {
          nextCursor = null;
          break;
        }
        cursor = String(res.next_cursor);
        start = undefined;
      }
      if (pages >= QUERY_SCAN_PAGES_MAX && matches.length >= limit) {
        scanTruncated = true;
        truncated = true;
      }
    } else {
      // Backward scan windows from newest to oldest; bounded by RAM window and pages.
      let high = seqTo ?? (opts.cursor ? Number(opts.cursor) - 1 : ramLatest);
      const floor = ramEarliest ?? 1;
      while (
        high != null &&
        high >= floor &&
        matches.length < limit &&
        pages < QUERY_SCAN_PAGES_MAX
      ) {
        const low = Math.max(floor, high - QUERY_PAGE_MAX + 1);
        const res = await this.rpc.request(
          "LOG_QUERY",
          this._portParams({
            ...(opts.dir ? { dir: opts.dir } : {}),
            seq_from: low,
            seq_to: high,
            limit: QUERY_PAGE_MAX,
          }),
          15000,
        );
        pages += 1;
        const entries = Array.isArray(res.entries) ? res.entries : [];
        scanned += entries.length;
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          if (matches.length >= limit) break;
          if (match(entries[i])) matches.push(entries[i]);
        }
        if (matches.length >= limit) {
          truncated = true;
          nextCursor = matches[matches.length - 1].seq - 1;
          break;
        }
        if (low <= floor) {
          nextCursor = null;
          break;
        }
        high = low - 1;
      }
      if (high != null && high >= floor && pages >= QUERY_SCAN_PAGES_MAX) {
        scanTruncated = true;
        truncated = true;
        nextCursor = high;
      }
    }

    return this._queryResult({
      res: null,
      entries: matches,
      limit,
      order,
      ramEarliest,
      ramLatest,
      sdEarliest,
      sdLatest,
      scanned,
      pages,
      truncated,
      scanTruncated,
      nextCursor,
      opts,
    });
  }

  _queryResult({
    res,
    entries,
    limit,
    order,
    ramEarliest,
    ramLatest,
    sdEarliest,
    sdLatest,
    scanned,
    pages,
    truncated,
    scanTruncated,
    nextCursor,
    opts,
  }) {
    return {
      connection_id: this.id,
      transport: "remote",
      source: "device",
      authoritative: true,
      storage: res?.storage,
      entries,
      count: entries.length,
      truncated,
      next_cursor: nextCursor,
      // `earliest_seq` is kept for old clients; it is the RAM window start.
      earliest_seq: ramEarliest,
      ram_earliest_seq: ramEarliest,
      ram_latest_seq: ramLatest,
      sd_earliest_seq: sdEarliest,
      sd_latest_seq: sdLatest,
      scanned,
      pages,
      scan_truncated: scanTruncated,
      time_source: res?.time_source ?? "tick",
      query: {
        limit,
        order,
        ...(opts.contains ? { contains: opts.contains } : {}),
        ...(opts.regex ? { regex: opts.regex } : {}),
      },
      ...(opts.time_from != null || opts.time_to != null
        ? { time_filter: "ignored (device clock is uptime tick)" }
        : {}),
    };
  }

  async stats() {
    const res = await this.rpc.request("LOG_STATS", this._portParams(), 15000);
    return {
      connection_id: this.id,
      transport: "remote",
      source: "device",
      authoritative: true,
      ...res,
    };
  }

  async clear(connection_id, opts = {}) {
    // Called both directly (store.clear()) and via LogRouter.clear(id, opts).
    const o = connection_id && typeof connection_id === "object" ? connection_id : opts;
    const res = await this.rpc.request(
      "LOG_CLEAR",
      this._portParams({ ...(o.segment ? { segment: o.segment } : {}) }),
      15000,
    );
    return {
      connection_id: this.id,
      transport: "remote",
      source: "device",
      ...res,
    };
  }

  /**
   * Control-plane events from the device (SD mount/remount/write errors,
   * ring drops, ...). Independent of the UART data log.
   */
  async events(opts = {}) {
    const params = this._portParams({
      ...(Number.isFinite(opts.seq_from) ? { seq_from: opts.seq_from } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
      ...(opts.level ? { level: opts.level } : {}),
    });
    const res = await this.rpc.request("EVENT_QUERY", params, 10000);
    return {
      connection_id: this.id,
      transport: "remote",
      source: "device",
      ...res,
    };
  }

  /**
   * Export the device SD log into a host file.
   * @param {{dir?:string, seq_from?:number, seq_to?:number, path?:string,
   *          out_dir?:string, max_bytes?:number, time_from?:number,
   *          time_to?:number}} opts
   */
  async export(opts = {}) {
    const dir = opts.dir === "tx" ? "tx" : "rx";
    const file =
      opts.path ||
      (opts.out_dir
        ? path.join(opts.out_dir, `export-${Date.now()}.log`)
        : defaultExportPath(this.id));

    const maxBytes = Math.min(Math.max(opts.max_bytes ?? 32768, 256), 65536);
    const maxPages = Number.isFinite(opts.max_pages) ? Math.max(1, opts.max_pages) : 10000;
    const append = Boolean(opts.append);
    const seqFrom = Number.isFinite(opts.seq_from) ? opts.seq_from : undefined;
    const seqTo = Number.isFinite(opts.seq_to) ? opts.seq_to : undefined;
    const segment = opts.segment ? String(opts.segment) : undefined;

    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch (_) {}

    const out = fs.createWriteStream(file, { flags: append ? "a" : "w" });
    let cursor = "0";
    let pages = 0;
    let bytes = 0;
    let lines = 0;
    let firstSeq = null;
    let lastSeq = null;
    let actualSegment = segment ?? null;
    let eof = false;

    try {
      for (;;) {
        const res = await this.rpc.request(
          "LOG_EXPORT",
          this._portParams({
            dir,
            ...(seqFrom != null ? { seq_from: seqFrom } : {}),
            ...(seqTo != null ? { seq_to: seqTo } : {}),
            ...(segment ? { segment } : {}),
            cursor,
            max_bytes: maxBytes,
          }),
          30000,
        );
        const chunk = Buffer.from(res.chunk_b64 || "", "base64");
        const index = Buffer.from(res.index_b64 || "", "base64");
        if (res.segment) actualSegment = res.segment;
        bytes += chunk.length;

        for (let o = 0; o + INDEX_REC_BYTES <= index.length; o += INDEX_REC_BYTES) {
          const off = Number(index.readBigUInt64LE(o));
          const seq = index.readUInt32LE(o + 8);
          const len = index.readUInt16LE(o + 16);
          if (len === 0 || off + len > chunk.length) continue;
          const buf = chunk.subarray(off, off + len);
          out.write(buf);
          lines += 1;
          if (firstSeq == null) firstSeq = seq;
          lastSeq = seq;
        }

        pages += 1;
        eof = Boolean(res.eof);
        if (eof) break;
        const next = res.next_cursor != null ? String(res.next_cursor) : null;
        if (!next || next === cursor) break;
        cursor = next;
        if (pages >= maxPages) break;
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }

    return {
      connection_id: this.id,
      transport: "remote",
      source: "device",
      authoritative: true,
      path: file,
      dir,
      segment: actualSegment,
      bytes,
      lines,
      pages,
      max_pages: maxPages,
      append,
      eof,
      first_seq: firstSeq,
      last_seq: lastSeq,
      ...(opts.time_from != null || opts.time_to != null
        ? { time_filter: "ignored (device clock is uptime tick)" }
        : {}),
    };
  }

  /**
   * Incremental host archive: export every segment/dir up to the snapshot's
   * latest_seq, appending to per-segment files and persisting a per-dir
   * watermark in <out_dir>/state.json. Subsequent calls only fetch new seq.
   */
  async sync(opts = {}) {
    const stats = await this.stats();
    const segments = Array.isArray(stats.segments) ? stats.segments : [];
    if (segments.length === 0) {
      throw new Error("设备没有可同步的 SD segment（has_sd/log_export 不可用？）");
    }
    const dirs = opts.dir ? [opts.dir] : ["rx", "tx"];
    for (const d of dirs) {
      if (d !== "rx" && d !== "tx") throw new Error("dir must be rx|tx");
    }
    const endpoint = safeName(this.config.endpoint || this.id);
    const outDir = opts.out_dir || path.join(defaultSyncDir(), endpoint);
    fs.mkdirSync(outDir, { recursive: true });
    const stateFile = path.join(outDir, "state.json");
    const state = readState(stateFile);
    const maxPages = Number.isFinite(opts.max_pages) ? Math.max(1, opts.max_pages) : 10000;
    const wanted = opts.segment ? String(opts.segment) : null;
    if (wanted && !segments.some((s) => s.id === wanted)) {
      throw new Error(`segment 不存在: ${wanted}`);
    }

    let bytes = 0;
    let lines = 0;
    let pages = 0;
    const results = [];
    const errors = [];
    for (const seg of segments) {
      if (wanted && seg.id !== wanted) continue;
      const segState = state[seg.id] || { rx: 0, tx: 0 };
      const latest = Number(seg.latest_seq) || 0;
      for (const dir of dirs) {
        const wm = Number(segState[dir]) || 0;
        if (!latest || latest <= wm) {
          results.push({ segment: seg.id, dir, skipped: true, watermark: wm, latest });
          continue;
        }
        const file = path.join(outDir, `${safeName(seg.id)}-${dir}.log`);
        let from = wm + 1;
        let append = wm > 0;
        let last = wm;
        let eof = false;
        let segBytes = 0;
        let segLines = 0;
        let segPages = 0;
        try {
          for (let round = 0; round < 100; round += 1) {
            const r = await this.export({
              segment: seg.id,
              dir,
              seq_from: from,
              seq_to: latest,
              path: file,
              append,
              max_pages: maxPages,
              ...(Number.isFinite(opts.max_bytes) ? { max_bytes: opts.max_bytes } : {}),
            });
            segBytes += r.bytes;
            segLines += r.lines;
            segPages += r.pages;
            if (Number.isFinite(r.last_seq)) last = Math.max(last, r.last_seq);
            eof = r.eof;
            if (eof || r.last_seq == null || r.last_seq < from) break;
            from = r.last_seq + 1;
            append = true;
            if (from > latest) break;
          }
          if (last > wm) {
            segState[dir] = last;
            state[seg.id] = segState;
            writeState(stateFile, state);
          }
          bytes += segBytes;
          lines += segLines;
          pages += segPages;
          results.push({
            segment: seg.id,
            dir,
            file,
            from: wm + 1,
            to: last,
            latest,
            bytes: segBytes,
            lines: segLines,
            pages: segPages,
            eof,
          });
        } catch (err) {
          errors.push({ segment: seg.id, dir, error: err.message });
        }
      }
    }
    return {
      connection_id: this.id,
      transport: "remote",
      source: "device",
      authoritative: true,
      out_dir: outDir,
      state_file: stateFile,
      segments: results,
      bytes,
      lines,
      pages,
      errors,
    };
  }
}
