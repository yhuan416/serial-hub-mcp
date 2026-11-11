import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createLink, DEFAULT_BAUD, FLOW_MAP, TRANSPORTS } from "./links/index.js";
import { openRemoteConnection } from "./remote/connection.js";
import { RemoteLogStore } from "./remote/log_store.js";

// 默认 RX 缓冲上限。可用 open 的 rx_buffer_size 扩大（如高速串口/长时间日志）。
// 注意：此值只约束"未消费"的积压，不是生命周期内存上限；消费后（read/transact）即时释放。
const DEFAULT_RX_BUFFER = 4 * 1024 * 1024; // 4 MiB

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 单个串口连接：封装 serialport，维护 always-on RX 缓冲与消费游标，
 * 提供 write / collect(read/transact) / flush / status / close。
 *
 * RX 消费模型（baseline，无 framing）：
 *   - 分段缓冲 _chunks（Array<Buffer>）持续累积到站字节，_length 是总字节数（绝对尾部偏移）。
 *   - 追加是 O(chunk)（push），不整块复制；超过 cap 时从头丢弃最旧 chunk，避免 O(n) 重建。
 *   - handled 是"已被 read/transact 消费"的绝对偏移（全局游标）。
 *   - read 默认从 handled 消费；transact 从调用时刻的快照 base 消费（忽略写前噪声）。
 *   - collect 只负责"拿到满足条件的一段"，不直接推进 handled，由调用方推进并返回片段。
 */
class Connection {
  constructor(manager, port, config, logStore) {
    this.manager = manager;
    this.id = crypto.randomUUID();
    this.port = port;
    this.config = config;
    this.logStore = logStore || null;
    this._chunks = []; // Array<Buffer>，首元素最旧
    this._length = 0; // 已缓冲总字节数（绝对尾部偏移）
    this.handled = 0; // 已消费绝对偏移
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.dropped = 0; // RX 超 cap 被丢弃的字节数（消费前丢最旧，监视是否丢数据）
    this.waiters = [];
    this.closed = false;
    this._pumpError = null;
    this.dtr = null; // 最近一次设置的 DTR 电平（null 表示未显式设置）
    this.rts = null; // 最近一次设置的 RTS 电平

    port.on("data", (chunk) => this._onData(chunk));
    port.on("error", (err) => this._onError(err));
    port.on("close", () => this._onClose());
  }

  // ── RX 泵 ──────────────────────────────────────────────
  _onData(chunk) {
    if (this.closed) return;
    if (!chunk || chunk.length === 0) return;
    this.bytesIn += chunk.length;

    // 喂给日志层（按行切分），独立于字节缓冲
    if (this.logStore) this.logStore.addData(this.id, chunk);

    // 追加：push 新 chunk，常数时间，不拷贝旧数据
    this._chunks.push(chunk);
    this._length += chunk.length;

    // 超上限：从头丢弃最旧字节
    const cap = this.config.rx_buffer_size;
    if (this._length > cap) this._dropHead(this._length - cap);

    this._notify();
  }

  /**
   * 从头丢弃 n 字节（最旧）。丢弃会同步回退 handled，保证 handled <= _length。
   * @param {number} n
   */
  _dropHead(n) {
    if (n <= 0) return;
    let remaining = n;
    while (remaining > 0 && this._chunks.length) {
      const first = this._chunks[0];
      if (first.length <= remaining) {
        remaining -= first.length;
        this._chunks.shift(); // 整块丢弃，GC 可回收
      } else {
        // 落在最后一个 chunk 中间：拷贝剩余小段，旧帧前半段可回收
        this._chunks[0] = Buffer.from(first.subarray(remaining));
        remaining = 0;
      }
    }
    this._length -= n;
    this.handled = Math.max(0, this.handled - n);
    this.dropped += n;
  }

  // ── 缓冲区间工具 ───────────────────────────────────────
  /** 定位绝对偏移 offset 所在的 chunk 及局部下标；超出则返回 null。 */
  _locate(offset) {
    if (offset < 0 || offset >= this._length) return null;
    let acc = 0;
    for (const c of this._chunks) {
      if (offset < acc + c.length) return { chunk: c, local: offset - acc };
      acc += c.length;
    }
    return null;
  }

  /** 返回 [start,end) 的新 Buffer 拷贝（独立于内部缓冲）。 */
  _sliceRange(start, end) {
    start = Math.max(0, start);
    end = Math.min(end, this._length);
    if (end <= start) return Buffer.alloc(0);
    const parts = [];
    let offset = 0;
    for (const c of this._chunks) {
      const s = offset;
      const e = offset + c.length;
      offset = e;
      if (e <= start) continue;
      if (s >= end) break;
      const ls = Math.max(start, s) - s;
      const le = Math.min(end, e) - s;
      parts.push(c.subarray(ls, le));
    }
    return Buffer.concat(parts);
  }

  /** 逐字节（跨 chunk）比较从 at 起的 needle。 */
  _rangeEquals(needle, at) {
    let abs = at;
    let n = 0;
    while (n < needle.length) {
      const loc = this._locate(abs);
      if (!loc) return false;
      const avail = loc.chunk.length - loc.local;
      const take = Math.min(avail, needle.length - n);
      if (!loc.chunk.subarray(loc.local, loc.local + take).equals(needle.subarray(n, n + take))) {
        return false;
      }
      abs += take;
      n += take;
    }
    return true;
  }

  /** 从绝对偏移 from 起查找 needle（跨 chunk），返回绝对偏移或 -1。 */
  _indexOf(needle, from) {
    if (!needle || needle.length === 0 || from >= this._length) return -1;
    const first = needle[0];
    let offset = 0;
    for (const c of this._chunks) {
      const start = offset;
      const stop = offset + c.length;
      offset = stop;
      if (stop <= from) continue;
      const localFrom = Math.max(0, from - start);
      let hit = c.indexOf(first, localFrom);
      while (hit !== -1) {
        const abs = start + hit;
        if (abs >= from && this._rangeEquals(needle, abs)) return abs;
        hit = c.indexOf(first, hit + 1);
      }
    }
    return -1;
  }

  _onError(err) {
    // 记录错误但不立即关闭；交由工具层决定是否报错
    this._pumpError = err;
    this._notify();
  }

  _onClose() {
    this.closed = true;
    this._failWaiters(new Error("串口已关闭"));
  }

  // ── 等待器：每个等待者持有一个 check()，满足或超时即 resolve ──
  _notify() {
    const pending = [];
    for (const w of this.waiters) {
      const res = w.check();
      if (res) {
        clearTimeout(w.timer);
        w.resolve(res);
      } else {
        pending.push(w);
      }
    }
    this.waiters = pending;
  }

  _failWaiters(err) {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve({ timedOut: true, error: err.message });
    }
    this.waiters = [];
  }

  /**
   * 从 base 起找到一个满足条件的字节区间 [{start,end}]。
   * 不推进 handled。超时返回 {timedOut:true, end:base}。
   * @param {number} base
   * @param {{match?:Buffer, minBytes?:number, waitMs?:number}} opts
   * @returns {Promise<{start:number, end:number, matched:boolean, timedOut:boolean, error?:string}>}
   */
  async collect(base, opts = {}) {
    const { match, minBytes = 1, waitMs = 0 } = opts;
    base = Math.max(0, Math.min(base, this._length));

    const satisfied = () => {
      const avail = this._length - base;
      if (avail <= 0) return null;
      if (match && match.length > 0) {
        const idx = this._indexOf(match, base);
        if (idx >= 0) return { start: base, end: idx + match.length, matched: true };
      }
      if ((!match || match.length === 0) && avail >= minBytes) {
        return { start: base, end: this._length, matched: false };
      }
      return null;
    };

    let res = satisfied();
    if (res) {
      return { ...res, timedOut: false };
    }
    if (this._pumpError) {
      return {
        start: base,
        end: base,
        matched: false,
        timedOut: true,
        error: this._pumpError.message,
      };
    }

    if (waitMs <= 0) {
      return { start: base, end: base, matched: false, timedOut: true };
    }

    return new Promise((resolve) => {
      const waiter = {
        check: () => {
          let r = satisfied();
          if (r) return { ...r, timedOut: false };
          if (this._pumpError) {
            return {
              start: base,
              end: base,
              matched: false,
              timedOut: true,
              error: this._pumpError.message,
            };
          }
          if (this.closed)
            return { start: base, end: base, matched: false, timedOut: true, error: "串口已关闭" };
          return null;
        },
        resolve,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve({ start: base, end: base, matched: false, timedOut: true });
      }, waitMs);
      this.waiters.push(waiter);
    });
  }

  // ── 对外操作 ────────────────────────────────────────────

  /**
   * 读：从 handled 起消费。返回含字节片段。
   * @param {{match?:Buffer, minBytes?:number, waitMs?:number}} opts
   */
  async read(opts = {}) {
    const res = await this.collect(this.handled, opts);
    if (res.end > this.handled) this.handled = res.end;
    const data = this._sliceRange(res.start, res.end);
    return {
      connection_id: this.id,
      data,
      start_offset: res.start,
      end_offset: res.end,
      matched: res.matched,
      timed_out: res.timedOut,
      error: res.error || null,
    };
  }

  /**
   * 收发交互：写后从调用时刻快照 base 起等响应。忽略写前已缓冲的噪声。
   * 返回 {data, ...}。
   */
  async transact(payload, opts = {}) {
    const base = this._length; // 只关心写之后到达的字节
    await this.write(payload);
    const res = await this.collect(base, opts);
    if (res.end > this.handled) this.handled = res.end;
    const data = this._sliceRange(res.start, res.end);
    return {
      connection_id: this.id,
      data,
      start_offset: res.start,
      end_offset: res.end,
      matched: res.matched,
      timed_out: res.timedOut,
      error: res.error || null,
    };
  }

  write(buf) {
    if (this.closed) return Promise.reject(new Error("串口已关闭"));
    return new Promise((resolve, reject) => {
      this.port.write(buf, (err) => {
        if (err) return reject(err);
        this.bytesOut += buf.length;
        this.port.drain((drainErr) => {
          if (drainErr) return reject(drainErr);
          // 一次 write 记一条 TX 日志（不切行）
          if (this.logStore) this.logStore.addTx(this.id, buf);
          resolve(buf.length);
        });
      });
    });
  }

  // ── 控制线（DTR / RTS / BREAK）───────────────────────

  /** 直接设置 DTR / RTS 电平；未传的线保持不动。 */
  setLine({ dtr, rts }) {
    if (this.closed) return Promise.reject(new Error("串口已关闭"));
    return new Promise((resolve, reject) => {
      const opts = {};
      if (dtr !== undefined) opts.dtr = dtr;
      if (rts !== undefined) opts.rts = rts;
      if (Object.keys(opts).length === 0) return resolve({ dtr: this.dtr, rts: this.rts });
      this.port.set(opts, (err) => {
        if (err) return reject(err);
        if (dtr !== undefined) this.dtr = dtr;
        if (rts !== undefined) this.rts = rts;
        resolve({ dtr: this.dtr, rts: this.rts });
      });
    });
  }

  /**
   * 电平脉冲：先设为 dtr/rts 值，保持 pulseMs 后反转（复位/进入 bootloader 常用）。
   * Arduino 复位：{ dtr:false, pulseMs:100 }；ESP32 下载可用多次 setLine 组合精确时序。
   */
  async setPulse({ dtr, rts, pulseMs }) {
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

  /** 发送 BREAK 信号，保持 durationMs 后释放。 */
  sendBreak(durationMs) {
    if (this.closed) return Promise.reject(new Error("串口已关闭"));
    return new Promise((resolve, reject) => {
      this.port.set({ brk: true }, (err) => {
        if (err) return reject(err);
        setTimeout(() => {
          this.port.set({ brk: false }, (err2) => (err2 ? reject(err2) : resolve()));
        }, durationMs);
      });
    });
  }

  /**
   * 通用"收集窗口"：从当前游标起持续观察/消费，直到结束条件。
   * 结束条件优先级：match(字节) 出现 > 达到 max_bytes > 静默 idleTimeoutMs > budgetMs 耗尽。
   * 注意：match 只作"终止标志"，不做门槛——期间到达的非匹配字节也会被持续消费并带回；
   * 对内容（正则/提示符等）不做判读，判读交给 agent。
   * @param {{match?:Buffer, idleTimeoutMs?:number, budgetMs?:number, maxBytes?:number}} opts
   * @returns {Promise<{data:Buffer, start:number, end:number, matched:boolean, stopReason:string}>}
   */
  async _collectWindow({ match, idleTimeoutMs = 300, budgetMs = 3000, maxBytes } = {}) {
    const t0 = Date.now();
    const deadline = t0 + budgetMs;
    const base = this.handled;
    let matchScan = base; // 上一次 match 扫描终止点；下次从它回退 overlap 字节起，避免全量重扫
    const overlap = match && match.length > 0 ? match.length - 1 : 0;
    let stopReason;

    for (;;) {
      if (this._pumpError) {
        stopReason = "error";
        break;
      }
      if (this.closed) {
        stopReason = "closed";
        break;
      }
      if (Date.now() >= deadline) {
        stopReason = "budget";
        break;
      }

      // 1) match：从 last 扫描点回退 overlap 个字节起扫（兼容跨 chunk / 跨到达补齐）
      if (match && match.length > 0) {
        const from = Math.max(base, matchScan - overlap);
        const idx = this._indexOf(match, from);
        matchScan = this._length;
        if (idx >= 0) {
          const end = idx + match.length;
          const data = this._sliceRange(base, end);
          this.handled = end;
          return { data, start: base, end, matched: true, stopReason: "match" };
        }
      }

      // 2) 字节上限
      const avail = this._length - base;
      if (maxBytes && avail >= maxBytes) {
        const data = this._sliceRange(base, this._length);
        this.handled = this._length;
        return { data, start: base, end: this._length, matched: false, stopReason: "max_bytes" };
      }

      // 3) 等下一批数据（不消费，游标留在 base）；静默 idleTimeoutMs 即停
      const remain = deadline - Date.now();
      const waitMs = Math.max(0, Math.min(idleTimeoutMs, remain));
      if (waitMs <= 0) {
        stopReason = "budget";
        break;
      }
      const r = await this.collect(this._length, { minBytes: 1, waitMs });
      if (!r.timedOut) continue; // 有新数据，回到 1) 重新判 match
      stopReason = "idle";
      break;
    }

    // 兜底：把窗口内已到达的（含非匹配）数据带回
    const data = this._sliceRange(base, this._length);
    this.handled = this._length;
    return { data, start: base, end: this._length, matched: false, stopReason };
  }

  _windowFrame(r, opts) {
    const t0 = opts.t0;
    const stopped_reason = r.stopReason || "budget";
    return {
      connection_id: this.id,
      bytes: r.data.length,
      text: r.data.toString("utf8"),
      hex: r.data.toString("hex"),
      start_offset: r.start,
      end_offset: r.end,
      matched: r.matched,
      timed_out:
        stopped_reason === "idle" || stopped_reason === "budget" || stopped_reason === "closed",
      stopped_reason,
      total_time_ms: Date.now() - t0,
    };
  }

  /**
   * 统一"接收窗口"：持续收集到达字节直到结束条件，期间数据如实带回、内容判读交给 agent。
   * start='flush' 先清缓冲（干净窗口）＋可选 reset 复位（抓 boot 用），start='cursor' 从当前游标开始。
   * 结束条件：match(字节) 出现 > max_bytes > 静默 idleTimeoutMs > budgetMs。
   */
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

    const r = await this._collectWindow({ match, idleTimeoutMs, budgetMs, maxBytes });
    const f = this._windowFrame(r, { t0 });
    if (resetUsed) f.reset = resetUsed;
    return f;
  }

  /**
   * 大流量/长日志直落盘：RX 字节边收边写文件，返回文件路径与结尾预览，
   * 避免经 MCP 往返搬运大字节。结束条件：match(字节) > max_bytes > 静默 idleTimeoutMs > budgetMs。
   */
  async dumpToFile({
    file,
    flush = false,
    match,
    idleTimeoutMs = 300,
    budgetMs = 5000,
    maxBytes,
  } = {}) {
    const t0 = Date.now();
    const deadline = t0 + budgetMs;
    if (flush) await this.flushInput();

    let base = this.handled;
    let collected = 0;
    let stopReason = "budget";
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch (_) {}
    const stream = fs.createWriteStream(file);
    let writeErr = null;
    const writeBuf = (buf) =>
      new Promise((res) => {
        if (!buf || buf.length === 0) return res();
        stream.write(buf, (e) => {
          if (e) writeErr = e;
          res();
        });
      });
    const consumeTo = async (end) => {
      const d = this._sliceRange(base, end);
      this.handled = end;
      base = end;
      if (d.length) {
        await writeBuf(d);
        collected += d.length;
      }
    };

    try {
      for (;;) {
        if (writeErr) {
          stopReason = "error";
          break;
        }
        if (this._pumpError) {
          stopReason = "error";
          break;
        }
        if (this.closed) {
          stopReason = "closed";
          break;
        }
        if (Date.now() >= deadline) {
          stopReason = "budget";
          break;
        }
        const avail = this._length - base;
        if (avail > 0) {
          if (match && match.length > 0) {
            const idx = this._indexOf(match, base);
            if (idx >= 0) {
              await consumeTo(idx + match.length);
              stopReason = "match";
              break;
            }
          }
          await consumeTo(this._length);
          if (maxBytes && collected >= maxBytes) {
            stopReason = "max_bytes";
            break;
          }
          continue;
        }
        const remain = deadline - Date.now();
        const waitMs = Math.max(0, Math.min(idleTimeoutMs, remain));
        if (waitMs <= 0) {
          stopReason = "budget";
          break;
        }
        const r = await this.collect(this._length, { minBytes: 1, waitMs });
        if (!r.timedOut) continue;
        stopReason = "idle";
        break;
      }
    } finally {
      await new Promise((res) => stream.end(res));
    }

    // 结尾预览：≤2048B 全量；更大则前 512B + 尾 1536B
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
    } catch (_) {}

    return {
      path: file,
      bytes: fileBytes,
      matched: stopReason === "match",
      timed_out: stopReason === "idle" || stopReason === "budget" || stopReason === "closed",
      stopped_reason: stopReason,
      total_time_ms: Date.now() - t0,
      preview,
    };
  }

  async flushInput() {
    // 丢弃 OS 读缓冲 + 内部全部 backlog（清空分段缓冲，等效全部丢弃）
    this._chunks = [];
    this._length = 0;
    this.handled = 0;
    if (typeof this.port.flush === "function") {
      return new Promise((resolve) => this.port.flush((e) => resolve(!e)));
    }
    return true;
  }

  async flushOutput() {
    if (typeof this.port.drain === "function") {
      return new Promise((resolve) => this.port.drain((e) => resolve(!e)));
    }
    return true;
  }

  status() {
    const transport = this.config.transport ?? "serial";
    const port =
      transport === "serial"
        ? (this.port.path ?? this.config.port ?? null)
        : (this.config.endpoint ?? this.config.port ?? null);
    return {
      connection_id: this.id,
      transport,
      endpoint: this.config.endpoint ?? null,
      port,
      open: !this.closed,
      config: this.config,
      bytes_in: this.bytesIn,
      bytes_out: this.bytesOut,
      rx_buffered: this._length - this.handled,
      rx_dropped: this.dropped,
      dtr: this.dtr,
      rts: this.rts,
      current_partial_line: this.logStore ? this.logStore.currentPartial(this.id) : null,
      error: this._pumpError ? this._pumpError.message : null,
    };
  }

  async close() {
    this.closed = true;
    if (this.logStore) this.logStore.unregister(this.id);
    return new Promise((resolve, reject) => {
      this.port.close((err) => {
        if (err && err.message !== "Port is not open") return reject(err);
        resolve();
      });
    });
  }
}

/**
 * 连接管理器：按 connection_id 持有打开的串口连接。
 * baseline 一次只关心少量连接，但支持并发多连接（用 connection_id 区分）。
 */
class ConnectionManager {
  /**
   * @param {object|null} logStore 日志后端（可为 LogStore 或 LogRouter）
   * @param {{linkFactory?:(cfg:object)=>object}} [options]
   *   linkFactory 产出 Connection 所需的 port 鸭子类型；测试可注入假链路。
   */
  constructor(logStore, options = {}) {
    this.connections = new Map();
    this.logStore = logStore || null;
    this.linkFactory = options.linkFactory || createLink;
  }

  /**
   * 打开一条链路。
   * @param {{transport?:string, endpoint?:string, port?:string, baud_rate?:number,
   *          data_bits?:number, stop_bits?:number, parity?:string, flow_control?:string,
   *          rx_buffer_size?:number, newline?:string}} args
   */
  async open(args) {
    const transport = args.transport ?? "serial";
    if (!TRANSPORTS.includes(transport)) {
      throw new Error(`transport 非法: ${transport}，应为 ${TRANSPORTS.join("|")}`);
    }
    const endpoint = args.endpoint ?? null;
    if (transport === "remote" && !endpoint) {
      throw new Error("transport=remote 需要 endpoint（如 tcp://esp32s3-01:7000）");
    }
    if (transport === "serial" && !args.port) {
      throw new Error("缺少端口参数 port");
    }

    const path = transport === "serial" ? args.port : (args.port ?? endpoint);
    const baud_rate = args.baud_rate ?? DEFAULT_BAUD;
    const data_bits = args.data_bits ?? 8;
    const stop_bits = args.stop_bits ?? 1;
    const parity = args.parity ?? "none";
    const flow_control = args.flow_control ?? "none";
    const rx_buffer_size = args.rx_buffer_size ?? DEFAULT_RX_BUFFER;

    if (![5, 6, 7, 8].includes(data_bits)) {
      throw new Error(`data_bits 非法: ${data_bits}，应为 5/6/7/8`);
    }
    if (![1, 2].includes(stop_bits)) {
      throw new Error(`stop_bits 非法: ${stop_bits}，应为 1/2`);
    }
    if (!["none", "even", "odd"].includes(parity)) {
      throw new Error(`parity 非法: ${parity}，应为 none/even/odd`);
    }
    if (!(flow_control in FLOW_MAP)) {
      throw new Error(`flow_control 非法: ${flow_control}，应为 none/rtscts/dsrdtr/xon/xoff`);
    }
    if (rx_buffer_size < 1) {
      throw new Error("rx_buffer_size 必须 >= 1");
    }

    const config = {
      transport,
      endpoint,
      port: path,
      port_id: args.port_id ?? null,
      token: args.token ?? null,
      baud_rate,
      data_bits,
      stop_bits,
      parity,
      flow_control,
      rx_buffer_size,
      newline: args.newline ?? "none",
    };

    // 远端：直接构建 RemoteConnection（内部完成 HELLO/LOG_STATS，按需 pull）。
    if (transport === "remote") {
      const conn = await openRemoteConnection(config);
      this.connections.set(conn.id, conn);
      if (this.logStore && typeof this.logStore.bind === "function") {
        this.logStore.bind(conn.id, new RemoteLogStore(conn));
      }
      return conn.status();
    }

    const port = this.createPort(config);
    await new Promise((resolve, reject) => {
      port.open((err) => (err ? reject(err) : resolve()));
    });

    const conn = new Connection(this, port, config, this.logStore);
    this.connections.set(conn.id, conn);
    return conn.status();
  }

  /**
   * 按 config 构建链路端口（open 与断线自动重连共用；测试可 stub）。
   * @param {object} cfg 连接配置（含 transport/endpoint/串口参数）
   */
  createPort(cfg) {
    return this.linkFactory(cfg);
  }

  get(id) {
    return this.connections.get(id) || null;
  }

  list() {
    return [...this.connections.values()].map((c) => c.status());
  }

  async close(id) {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`连接不存在: ${id}`);
    if (this.logStore && typeof this.logStore.unbind === "function") {
      this.logStore.unbind(id);
    }
    await conn.close();
    this.connections.delete(id);
    return conn.status();
  }

  async closeAll() {
    for (const [id, conn] of this.connections) {
      if (this.logStore && typeof this.logStore.unbind === "function") {
        this.logStore.unbind(id);
      }
      try {
        await conn.close();
      } catch (_) {}
    }
    this.connections.clear();
  }
}

export { ConnectionManager, Connection, DEFAULT_BAUD };
