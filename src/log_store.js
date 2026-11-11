import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// LogStore —— 串口日志的精细管理 + 内存有界 + 溢出落盘（分区轮转 + 保留淘汰）。
//
// 模型（按用户选择）：
//   - 条目粒度：按行切分（\n / \r\n），一条日志 = 一行。TX 一次 write 记一条（不切行）。
//   - 存储分两层：
//       * 内存：进程内保留最近 N 条（可配置 memEntries），最旧自动溢出到磁盘。
//       * 磁盘：每连接一个目录 `logs/<conn>/{part-NNNNNN}.jsonl`，按大小分片轮转；
//         超过 retainBytes 的**最旧分片整文件删除**（淘汰 = 删整文件，不逐行改写）。
//   - 条目标识：全局单调递增 seq + epoch 毫秒时间戳 ts，支持 agent 按索引/时间/方向/内容检索。
//
// 条目结构：{ seq, ts, conn, dir:'rx'|'tx', line, hex, bytes }
//   - line: utf8 解码（非文本退化为占位），hex: 原始字节十六进制，bytes: 字节数。

const DEFAULT_MEM_ENTRIES = 1000;
// 每连接磁盘保留上限（字节）。超出后从最旧分片整文件删除。
const DEFAULT_RETAIN_BYTES = 64 * 1024 * 1024; // 64 MiB
// 单个分片文件大小上限（字节），达到后滚动到下一个 part- 文件。
const DEFAULT_PART_BYTES = 8 * 1024 * 1024; // 8 MiB
const PART_RE = /^part-\d{6}\.jsonl$/;

function defaultLogsDir() {
  if (process.env.SERIAL_HUB_MCP_LOGS_DIR) return process.env.SERIAL_HUB_MCP_LOGS_DIR;
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "serial-hub-mcp", "logs");
}

class LogStore {
  /**
   * @param {{dir?:string|null, memEntries?:number, retainBytes?:number, partBytes?:number}} opts
   *   dir 为日志根目录；null 表示仅内存（不落盘）。缺省用 SERIAL_HUB_MCP_LOGS_DIR 或 ~/.cache/serial-hub-mcp/logs。
   *   memEntries 内存保留条数上限（默认 1000），超出溢出到磁盘。
   *   retainBytes 每连接磁盘保留字节上限（默认 64 MiB，<=0 表示不淘汰、仅内存），超出删最旧分片文件。
   *   partBytes 单个分片文件字节上限（默认 8 MiB），达到后滚动新文件。
   */
  constructor(opts = {}) {
    this.dir = opts.dir === undefined ? defaultLogsDir() : opts.dir;
    this.memEntries = opts.memEntries ?? DEFAULT_MEM_ENTRIES;
    this.retainBytes = opts.retainBytes ?? DEFAULT_RETAIN_BYTES;
    this.partBytes = opts.partBytes && opts.partBytes > 0 ? opts.partBytes : DEFAULT_PART_BYTES;
    this.seq = 0;
    this.mem = []; // 内存条目，新在尾部，按 seq 升序
    this.partial = new Map(); // conn -> Buffer 残行（还没有换行符）
    this.streams = new Map(); // conn -> WriteStream（当前分片的追加流）
    this.conns = new Map(); // conn -> { dir, parts:[{file,size,count,seqMin,seqMax,tsMin,tsMax}], evicted }
    this.diskCount = new Map(); // conn -> 已落盘条数（含已淘汰；淘汰时用 evicted 抵消）
    this.timestamps = new Map(); // conn -> {min,max}
    this._writeChain = Promise.resolve(); // 串行写链，排空后磁盘与内存一致
    if (this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
      } catch (e) {
        // 目录不可用：降级为仅内存（不落盘），避免整个 MCP server 启动失败
        this.dir = null;
      }
    }
  }

  // ── 条目构建 ───────────────────────────────────────────
  _entry(conn, dir, bytes) {
    return {
      seq: ++this.seq,
      ts: Date.now(),
      conn,
      dir,
      line: bytes.toString("utf8"),
      hex: bytes.toString("hex"),
      bytes: bytes.length,
    };
  }

  _touch(conn, entry) {
    const t = this.timestamps.get(conn) || { min: Infinity, max: 0 };
    t.min = Math.min(t.min, entry.ts);
    t.max = Math.max(t.max, entry.ts);
    this.timestamps.set(conn, t);
  }

  _record(conn, entry) {
    this.diskCount.set(conn, (this.diskCount.get(conn) || 0) + 1);
    this._touch(conn, entry);
    this.mem.push(entry);
    this._trim();
  }

  // 溢出：内存超过上限，最旧条目落到磁盘
  _trim() {
    while (this.mem.length > this.memEntries) {
      const oldest = this.mem.shift();
      this._write(oldest.conn, oldest);
    }
  }

  // ── 分区文件模型 ───────────────────────────────────────
  _safe(conn) {
    return conn.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  /** 连接目录路径（每连接一个目录，内含 part-NNNNNN.jsonl）。 */
  _connDir(conn) {
    return path.join(this.dir, this._safe(conn));
  }

  /** 旧版兼容：单文件平铺时的文件路径（已无写入，保留用于读旧数据）。 */
  _legacyFile(conn) {
    return path.join(this.dir, `${this._safe(conn)}.jsonl`);
  }

  _ensure(conn) {
    let st = this.conns.get(conn);
    if (!st) {
      st = { dir: this._connDir(conn), parts: [], evicted: 0 };
      try {
        fs.mkdirSync(st.dir, { recursive: true });
      } catch (_) {
        /* 目录不可用，写入继续但可能异常 */
      }
      this.conns.set(conn, st);
    }
    return st;
  }

  /** 关闭当前分片流并开启下一个分片文件。返回新分片状态。 */
  _openPartition(conn, st) {
    const old = st.parts[st.parts.length - 1];
    if (old) {
      const s = this.streams.get(conn);
      if (s) {
        s.end();
        this.streams.delete(conn);
      }
    }
    const part = {
      file: path.join(st.dir, `part-${String(st.parts.length).padStart(6, "0")}.jsonl`),
      size: 0,
      count: 0,
      seqMin: null,
      seqMax: null,
      tsMin: null,
      tsMax: null,
    };
    st.parts.push(part);
    this.streams.set(conn, fs.createWriteStream(part.file, { flags: "a" }));
    return part;
  }

  _write(conn, entry) {
    if (!this.dir) return;
    const st = this._ensure(conn);
    this._writeChain = this._writeChain.then(
      () =>
        new Promise((resolve) => {
          let part = st.parts[st.parts.length - 1];
          if (!part || part.size >= this.partBytes) part = this._openPartition(conn, st);
          const line = JSON.stringify(entry) + "\n";
          part.size += Buffer.byteLength(line);
          part.count += 1;
          part.seqMin = part.seqMin == null ? entry.seq : part.seqMin;
          part.seqMax = entry.seq;
          part.tsMin = part.tsMin == null ? entry.ts : Math.min(part.tsMin, entry.ts);
          part.tsMax = Math.max(part.tsMax ?? 0, entry.ts);
          const s = this.streams.get(conn);
          if (s) s.write(line, () => resolve());
          else resolve();
          this._enforceRetention(st);
        }),
    );
  }

  /** 淘汰：保留上限内，从最旧分片整文件删，保证至少留下 active 分片。 */
  _enforceRetention(st) {
    if (this.retainBytes <= 0) return;
    let total = 0;
    for (const p of st.parts) total += p.size;
    while (st.parts.length > 1 && total > this.retainBytes) {
      const oldest = st.parts[0];
      if (oldest === st.parts[st.parts.length - 1]) break; // 绝不删 active 分片
      total -= oldest.size;
      try {
        fs.unlinkSync(oldest.file);
      } catch (_) {}
      st.parts.shift();
      st.evicted += oldest.count;
    }
  }

  /** 等待所有待落盘的写完成，保证磁盘与内存一致后供检索。 */
  async _flush() {
    if (this._writeChain) await this._writeChain;
  }

  _readFile(fp) {
    let raw = "";
    try {
      raw = fs.readFileSync(fp, "utf8");
    } catch (_) {
      return [];
    }
    const out = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch (_) {
        /* 跳过损坏行 */
      }
    }
    return out;
  }

  /** 读某连接的全部磁盘条目（重启后无内存分片表时全扫目录；带 isInMemory 表时有分片级时间裁剪）。 */
  _readDiskSmart(conn, timeFrom, timeTo) {
    if (!this.dir) return [];
    const st = this.conns.get(conn);
    if (st && st.parts.length) {
      const out = [];
      for (const p of st.parts) {
        if (timeFrom != null && p.tsMax < timeFrom) continue;
        if (timeTo != null && p.tsMin > timeTo) continue;
        for (const e of this._readFile(p.file)) out.push(e);
      }
      return out;
    }
    return this._readDisk(conn);
  }

  /** 兜底全读：扫描目录里的 part- 分片；兼容旧平铺文件。 */
  _readDisk(conn) {
    if (!this.dir) return [];
    const paths = [];
    const connDir = this._connDir(conn);
    try {
      if (fs.existsSync(connDir)) {
        for (const f of fs.readdirSync(connDir).sort()) {
          if (PART_RE.test(f)) paths.push(path.join(connDir, f));
        }
      }
    } catch (_) {}
    if (paths.length === 0) {
      const leg = this._legacyFile(conn);
      if (fs.existsSync(leg)) paths.push(leg);
    }
    const out = [];
    for (const fp of paths) {
      for (const e of this._readFile(fp)) out.push(e);
    }
    return out;
  }

  // ── 数据入口 ───────────────────────────────────────────

  /** RX：按行切分喂入。每次 data 事件调用。 */
  addData(conn, buffer) {
    if (!buffer || buffer.length === 0) return;
    const now = Date.now();
    let partial = this.partial.get(conn);
    if (!partial) partial = { buf: Buffer.alloc(0), startedAt: now, updatedAt: now };
    const data = partial.buf.length ? Buffer.concat([partial.buf, buffer]) : buffer;
    const n = data.length;
    let start = 0;
    for (let i = 0; i < n; i += 1) {
      if (data[i] === 0x0a) {
        // 遇到 \n，剥掉结尾 \r
        let lineEnd = i;
        if (i > start && data[i - 1] === 0x0d) lineEnd = i - 1;
        const lineBytes = Buffer.from(data.subarray(start, lineEnd));
        this._record(
          conn,
          this._entry(conn, "rx", lineBytes.length === 0 ? Buffer.alloc(0) : lineBytes),
        );
        start = i + 1;
      }
    }
    // 残行：本轮切分后剩余的尾部。start>0 说明新增内容里切出了完整行，残行是新起的行（startedAt 用本轮）；
    // start==0 说明全部追加到原残行上（保留原 startedAt）。
    const leftover = start >= n ? Buffer.alloc(0) : Buffer.from(data.subarray(start));
    if (leftover.length === 0) {
      this.partial.delete(conn);
    } else {
      this.partial.set(conn, {
        buf: leftover,
        startedAt: start > 0 ? now : partial.startedAt,
        updatedAt: now,
      });
    }
  }

  /**
   * 当前正在接收、尚未换行的残行（带自己的时间戳；不占 seq）。
   * 残行不占 seq：等后续换行会再成一条完整行，两个视角并存不冲突。
   * @returns {null | {text:string, hex:string, bytes:number, started_at:number, updated_at:number}}
   */
  currentPartial(conn) {
    const partial = this.partial.get(conn);
    if (!partial || partial.buf.length === 0) return null;
    return {
      text: partial.buf.toString("utf8"),
      hex: partial.buf.toString("hex"),
      bytes: partial.buf.length,
      started_at: partial.startedAt,
      updated_at: partial.updatedAt,
    };
  }

  /** TX：一次 write 记一条（不切行）。 */
  addTx(conn, buffer) {
    if (!buffer || buffer.length === 0) return;
    this._record(conn, this._entry(conn, "tx", Buffer.from(buffer)));
  }

  /** 连接关闭：flush 残行，结束写流（分片文件保留，供后续淘汰与查询）。 */
  unregister(conn) {
    const partial = this.partial.get(conn);
    if (partial && partial.buf.length > 0) {
      this._record(conn, this._entry(conn, "rx", partial.buf));
    }
    this.partial.delete(conn);
    const s = this.streams.get(conn);
    if (s) {
      s.end();
      this.streams.delete(conn);
    }
  }

  _knownConns() {
    const set = new Set();
    for (const e of this.mem) set.add(e.conn);
    for (const c of this.diskCount.keys()) set.add(c);
    for (const c of this.partial.keys()) set.add(c);
    for (const c of this.conns.keys()) set.add(c);
    if (this.dir) {
      try {
        for (const ent of fs.readdirSync(this.dir)) {
          const p = path.join(this.dir, ent);
          let s;
          try {
            s = fs.statSync(p);
          } catch (_) {
            continue;
          }
          if (s.isDirectory()) {
            set.add(ent); // 连接目录以 sanitized 名存在；conn 原始 id 无法反推，仅兜底
          } else if (s.isFile() && ent.endsWith(".jsonl")) {
            set.add(ent.slice(0, -6)); // 旧平铺文件 <safe>.jsonl
          }
        }
      } catch (_) {}
    }
    return [...set];
  }

  // ── 检索 ───────────────────────────────────────────────
  /**
   * @param {object} opts
   * @param {string} [opts.connection_id] 只查某连接；省略则全查
   * @param {'rx'|'tx'} [opts.dir]
   * @param {number} [opts.seq_from] [opts.seq_to] 按索引范围
   * @param {number} [opts.time_from] [opts.time_to] 按时间范围（epoch ms）
   * @param {string} [opts.contains] 子串匹配（区分大小写，作用于 line）
   * @param {string} [opts.regex] 正则匹配（作用于 line）
   * @param {number} [opts.limit] 返回条数上限（默认 100）
   * @param {'asc'|'desc'} [opts.order] 排序（默认 asc = 旧→新）
   */
  async query(opts = {}) {
    await this._flush();
    const connection_id = opts.connection_id;
    const dir = opts.dir;
    const seq_from = opts.seq_from;
    const seq_to = opts.seq_to;
    const time_from = opts.time_from;
    const time_to = opts.time_to;
    const contains = opts.contains;
    const regex = opts.regex ? new RegExp(opts.regex) : null;
    const limit = opts.limit ?? 100;
    const order = opts.order === "desc" ? "desc" : "asc";

    const conns = connection_id ? [connection_id] : this._knownConns();

    // 磁盘条目（能裁剪时按分片时间界提前跳过整文件）在前，内存在后。
    // seq 是全局单调的，统一按 seq 排序保证 order=asc 时全局有序
    // （否则多连接交错写入时磁盘+内存归并后时序错乱）。
    const merged = [];
    for (const c of conns) {
      for (const e of this._readDiskSmart(c, time_from, time_to)) merged.push(e);
    }
    for (const e of this.mem) {
      if (!connection_id || e.conn === connection_id) merged.push(e);
    }
    merged.sort((a, b) => a.seq - b.seq);

    const matches = merged.filter((e) => {
      if (connection_id && e.conn !== connection_id) return false;
      if (dir && e.dir !== dir) return false;
      if (seq_from != null && e.seq < seq_from) return false;
      if (seq_to != null && e.seq > seq_to) return false;
      if (time_from != null && e.ts < time_from) return false;
      if (time_to != null && e.ts > time_to) return false;
      if (contains && !e.line.includes(contains)) return false;
      if (regex && !regex.test(e.line)) return false;
      return true;
    });

    const total = merged.length;
    const count = matches.length;
    const ordered = order === "desc" ? matches.slice().reverse() : matches;
    const page = ordered.slice(0, limit);
    const capped = limit > 0 ? Math.min(limit, count) : count;

    // 保留信息：agent 据此判断「历史被淘汰过、earliest_seq 之后才完整」
    let partitions = 0;
    let evicted = 0;
    let diskBytes = 0;
    if (connection_id) {
      const st = this.conns.get(connection_id);
      if (st) {
        partitions = st.parts.length;
        evicted = st.evicted;
        for (const p of st.parts) diskBytes += p.size;
      }
    } else {
      for (const c of conns) {
        const st = this.conns.get(c);
        if (!st) continue;
        for (const p of st.parts) diskBytes += p.size;
      }
    }

    return {
      query: {
        connection_id: connection_id || null,
        dir: dir || null,
        seq_from: seq_from ?? null,
        seq_to: seq_to ?? null,
        time_from: time_from ?? null,
        time_to: time_to ?? null,
        contains: contains || null,
        regex: regex ? opts.regex : null,
        limit,
        order,
      },
      entries: page,
      count,
      total,
      truncated: capped > 0 && capped < count,
      earliest_seq: merged.length ? merged[0].seq : null,
      retention: {
        evicted_lines: evicted,
        disk_partitions: partitions,
        disk_bytes: diskBytes,
        retain_bytes: this.retainBytes,
        part_bytes: this.partBytes,
      },
      source: {
        memory: this.mem.length,
        disk_streams: this.streams.size,
        disk_dir: this.dir,
      },
      // 当前正在接收的残行（带时间戳，不占 seq）。单查给 current_partial；全查给 current_partials。
      current_partial: connection_id ? this.currentPartial(connection_id) : null,
      ...(!connection_id
        ? {
            current_partials: this._knownConns()
              .map((c) => ({ connection_id: c, ...this.currentPartial(c) }))
              .filter((x) => x.bytes),
          }
        : {}),
    };
  }

  // ── 统计 / 清理 ────────────────────────────────────────
  stats(connection_id) {
    const conns = connection_id ? [connection_id] : this._knownConns();
    const perConn = conns.map((c) => {
      const memCount = this.mem.filter((e) => e.conn === c).length;
      const st = this.conns.get(c);
      let diskCount = 0;
      let partitions = 0;
      let evicted = 0;
      let diskBytes = 0;
      if (st && st.parts.length) {
        for (const p of st.parts) {
          diskCount += p.count;
          diskBytes += p.size;
        }
        partitions = st.parts.length;
        evicted = st.evicted;
      } else {
        diskCount = this._readDisk(c).length;
      }
      const t = this.timestamps.get(c);
      return {
        connection_id: c,
        total: memCount + diskCount,
        memory: memCount,
        disk: diskCount,
        retained_in_memory: memCount > 0,
        time_range: t && t.min !== Infinity ? { min: t.min, max: t.max } : null,
        dir: this.dir ? this._connDir(c) : null,
        partitions,
        disk_bytes: diskBytes,
        evicted_lines: evicted,
      };
    });
    const total = perConn.reduce((a, c) => a + c.total, 0);
    return {
      log_dir: this.dir,
      mem_entries: this.memEntries,
      retain_bytes: this.retainBytes,
      part_bytes: this.partBytes,
      active_memory: this.mem.length,
      total,
      connections: perConn,
    };
  }

  clear(connection_id) {
    const endStream = (c) => {
      const s = this.streams.get(c);
      if (s) {
        s.end();
        this.streams.delete(c);
      }
    };
    if (connection_id) {
      endStream(connection_id);
      this.mem = this.mem.filter((e) => e.conn !== connection_id);
      this.partial.delete(connection_id);
      this.diskCount.delete(connection_id);
      this.timestamps.delete(connection_id);
      this.conns.delete(connection_id);
      if (this.dir) {
        const d = this._connDir(connection_id);
        try {
          if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
        } catch (_) {}
        const leg = this._legacyFile(connection_id);
        try {
          if (fs.existsSync(leg)) fs.unlinkSync(leg);
        } catch (_) {}
      }
    } else {
      this.mem = [];
      this.partial.clear();
      this.diskCount.clear();
      this.timestamps.clear();
      this.conns.clear();
      for (const s of this.streams.values()) s.end();
      this.streams.clear();
      if (this.dir) {
        try {
          fs.rmSync(this.dir, { recursive: true, force: true });
          fs.mkdirSync(this.dir, { recursive: true });
        } catch (_) {}
      }
    }
    return this.stats(connection_id);
  }
}

export { LogStore, defaultLogsDir, DEFAULT_MEM_ENTRIES, DEFAULT_RETAIN_BYTES, DEFAULT_PART_BYTES };
