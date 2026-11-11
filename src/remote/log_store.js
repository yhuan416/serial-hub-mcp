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
   * exported with LOG_EXPORT. contains/regex are filtered locally.
   * time_from/time_to are accepted but ignored: the device ts is uptime tick.
   */
  async query(opts = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const params = this._portParams({
      ...(opts.dir ? { dir: opts.dir } : {}),
      ...(Number.isFinite(opts.seq_from) ? { seq_from: opts.seq_from } : {}),
      ...(Number.isFinite(opts.seq_to) ? { seq_to: opts.seq_to } : {}),
      ...(opts.cursor ? { cursor: String(opts.cursor) } : {}),
      limit,
    });
    const res = await this.rpc.request("LOG_QUERY", params, 15000);
    let entries = Array.isArray(res.entries) ? res.entries : [];
    if (opts.contains) {
      entries = entries.filter((e) => String(e.line ?? "").includes(opts.contains));
    }
    if (opts.regex) {
      const re = new RegExp(opts.regex);
      entries = entries.filter((e) => re.test(String(e.line ?? "")));
    }
    if (opts.order === "desc") entries = entries.slice().reverse();
    return {
      connection_id: this.id,
      transport: "remote",
      source: "device",
      authoritative: true,
      storage: res.storage,
      entries,
      count: entries.length,
      truncated: Boolean(res.truncated),
      next_cursor: res.next_cursor ?? null,
      earliest_seq: res.earliest_seq,
      time_source: res.time_source,
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

  async clear() {
    const res = await this.rpc.request("LOG_CLEAR", this._portParams(), 15000);
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
    const seqFrom = Number.isFinite(opts.seq_from) ? opts.seq_from : undefined;
    const seqTo = Number.isFinite(opts.seq_to) ? opts.seq_to : undefined;

    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch (_) {}

    const out = fs.createWriteStream(file);
    let cursor = "0";
    let pages = 0;
    let bytes = 0;
    let lines = 0;
    let firstSeq = null;
    let lastSeq = null;
    let eof = false;

    try {
      for (;;) {
        const res = await this.rpc.request(
          "LOG_EXPORT",
          this._portParams({
            dir,
            ...(seqFrom != null ? { seq_from: seqFrom } : {}),
            ...(seqTo != null ? { seq_to: seqTo } : {}),
            cursor,
            max_bytes: maxBytes,
          }),
          30000,
        );
        const chunk = Buffer.from(res.chunk_b64 || "", "base64");
        const index = Buffer.from(res.index_b64 || "", "base64");
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
        if (pages > 10000) break;
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
      bytes,
      lines,
      pages,
      eof,
      first_seq: firstSeq,
      last_seq: lastSeq,
      ...(opts.time_from != null || opts.time_to != null
        ? { time_filter: "ignored (device clock is uptime tick)" }
        : {}),
    };
  }
}
