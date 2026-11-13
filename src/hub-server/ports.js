// PortManager — x86 串口服务端的多端口管理。
//
// 每个端口共享一份状态（ring + 日志 + 串口句柄），多个客户端各自携带
// from_offset 读取，互不影响。端口按需打开；支持热插拔（新端口自动出现）。

import path from "node:path";
import fs from "node:fs";
import { ByteRing } from "./ring.js";
import { SegmentStore, LineLog } from "./logs.js";

const DEFAULT_SETTINGS = {
  baud_rate: 115200,
  data_bits: 8,
  stop_bits: 1,
  parity: "none",
  flow_control: "none",
};

function portIdOf(portPath) {
  const base = path.basename(String(portPath || ""));
  return base || String(portPath);
}

function normalizeSettings(input = {}, base = DEFAULT_SETTINGS) {
  return {
    baud_rate: Number(input.baud_rate) > 0 ? Number(input.baud_rate) : base.baud_rate,
    data_bits: Number(input.data_bits) || base.data_bits,
    stop_bits: Number(input.stop_bits) || base.stop_bits,
    parity: ["none", "even", "odd", "mark", "space"].includes(input.parity)
      ? input.parity
      : base.parity,
    flow_control: ["none", "rtscts", "xon", "xoff", "dsrdtr"].includes(input.flow_control)
      ? input.flow_control
      : base.flow_control,
  };
}

function serialOptions(p, settings) {
  return {
    path: p.path,
    baudRate: settings.baud_rate,
    dataBits: settings.data_bits,
    stopBits: settings.stop_bits,
    parity: settings.parity,
    flowControl: settings.flow_control,
    autoOpen: false,
  };
}

export class PortManager {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {string[]} [opts.portFilter] 路径包含匹配（子串或 /re/），空=全部
   * @param {number} [opts.ringBytes] 每端口环形缓冲，默认 64 MiB
   * @param {number} [opts.ramEntries]
   * @param {number} [opts.segmentBytes]
   * @param {number} [opts.retentionBytes]
   * @param {number} [opts.retentionDays]
   * @param {Function} [opts.serialFactory] 测试注入：(path, settings) => serial-like
   * @param {Function} [opts.listPorts] 测试注入：async () => [{path,...}]
   */
  constructor(opts = {}) {
    this.dataDir = opts.dataDir;
    this.portFilter = opts.portFilter || [];
    this.ringBytes = Math.max(64 * 1024, opts.ringBytes ?? 64 * 1024 * 1024);
    this.ramEntries = opts.ramEntries ?? 20000;
    this.segmentBytes = opts.segmentBytes ?? 64 * 1024 * 1024;
    this.retentionBytes = opts.retentionBytes ?? 4 * 1024 * 1024 * 1024;
    this.retentionDays = opts.retentionDays ?? 7;
    this.serialFactory = opts.serialFactory || null;
    this.listPortsFn = opts.listPorts || null;
    this.defaults = normalizeSettings(opts.defaults || {}, DEFAULT_SETTINGS);
    this.ports = new Map(); // id -> state
    this.scanTimer = null;
    this.scanning = false;
    this.generation = 0;
    this._portSig = "";
  }

  async scan() {
    if (this.scanning) return this.list();
    this.scanning = true;
    try {
      let list = [];
      const realList = !this.listPortsFn;
      try {
        if (this.listPortsFn) list = await this.listPortsFn();
        else {
          const { SerialPort } = await import("serialport");
          list = await SerialPort.list();
        }
      } catch (err) {
        // 容器/精简系统可能缺 udevadm；保留已有端口，不让扫描失败拖垮服务
        this.lastScanError = err && err.message ? err.message : String(err);
        return this.list();
      }
      for (const p of list || []) {
        if (!p || !p.path) continue;
        if (!this._matchFilter(p.path)) continue;
        // 容器里 /sys 是宿主机的，可能列出未映射进 /dev 的串口；以设备节点存在为准
        if (realList) {
          try {
            fs.accessSync(p.path, fs.constants.F_OK);
          } catch (_) {
            continue;
          }
        }
        this._ensurePort(p);
      }
      this.lastScanError = null;
      const sig = [...this.ports.keys()].sort().join(",");
      if (sig !== this._portSig) {
        this._portSig = sig;
        this.generation += 1;
      }
      return this.list();
    } finally {
      this.scanning = false;
    }
  }

  _matchFilter(portPath) {
    if (!this.portFilter.length) return true;
    return this.portFilter.some((pat) => {
      const m = /^\/(.*)\/([gimsuy]*)$/.exec(pat);
      if (m) {
        try {
          return new RegExp(m[1], m[2]).test(portPath);
        } catch (_) {
          return false;
        }
      }
      return String(portPath).includes(pat);
    });
  }

  startAutoScan(intervalMs = 2000) {
    if (this.scanTimer) return;
    const tick = () => {
      this.scan().catch(() => {});
    };
    tick();
    this.scanTimer = setInterval(tick, Math.max(500, intervalMs));
    this.scanTimer.unref?.();
  }

  _ensurePort(info) {
    const id = portIdOf(info.path);
    let st = this.ports.get(id);
    if (st) {
      st.path = info.path;
      st.info = { ...st.info, ...info };
      return st;
    }
    st = {
      id,
      path: info.path,
      info,
      settings: { ...this.defaults },
      ring: null,
      log: null,
      serial: null,
      openPromise: null,
      missing: false,
      overflowEvents: 0,
      overflowBytes: 0,
      wake: new Set(),
      closeHandlers: new Set(),
    };
    this.ports.set(id, st);
    return st;
  }

  /** 懒加载引擎：只有真正使用（打开/读写/查日志）的端口才分配 ring 和磁盘目录。 */
  _ensureEngine(st) {
    if (st.log) return st;
    const dir = path.join(this.dataDir, st.id);
    const store = new SegmentStore({
      dir,
      segmentBytes: this.segmentBytes,
      retentionBytes: this.retentionBytes,
      retentionDays: this.retentionDays,
    });
    st.log = new LineLog({ store, ramEntries: this.ramEntries });
    st.ring = new ByteRing(this.ringBytes);
    return st;
  }

  /** 解析端口并确保引擎就绪（供 LOG_* 使用）。 */
  engine(portRef) {
    const st = this.resolve(portRef);
    if (!st) {
      const err = new Error(`port_not_found: ${portRef}`);
      err.code = "port_not_found";
      throw err;
    }
    return this._ensureEngine(st);
  }

  resolve(portRef) {
    if (!portRef) return null;
    const direct = this.ports.get(String(portRef));
    if (direct) return direct;
    for (const st of this.ports.values()) {
      if (st.path === portRef) return st;
      if (portIdOf(st.path) === portIdOf(portRef)) return st;
    }
    return null;
  }

  list() {
    return [...this.ports.values()].map((st) => ({
      id: st.id,
      path: st.path,
      kind: "uart",
      manufacturer: st.info?.manufacturer ?? null,
      serialNumber: st.info?.serialNumber ?? null,
      serial_number: st.info?.serialNumber ?? null,
      vendorId: st.info?.vendorId ?? null,
      vendor_id: st.info?.vendorId ?? null,
      productId: st.info?.productId ?? null,
      product_id: st.info?.productId ?? null,
      open: Boolean(st.serial && st.serial.isOpen),
      configured: Boolean(st.serial),
      baud_rate: st.settings.baud_rate,
      caps: {
        baud_min: 50,
        baud_max: 5000000,
        flow_control: ["none", "rtscts", "xon", "xoff", "dsrdtr"],
        can_set_lines: true,
        can_break: true,
        ring_bytes: this.ringBytes,
        log_capacity_bytes: this.retentionBytes,
        log_line_max_bytes: 4096,
      },
    }));
  }

  async _factory(st) {
    if (this.serialFactory) return this.serialFactory(st.path, st.settings);
    const { SerialPort } = await import("serialport");
    return new SerialPort(serialOptions(st, st.settings));
  }

  async openPort(portRef, settingsPatch) {
    const st = this.resolve(portRef);
    if (!st) {
      const err = new Error(`port_not_found: ${portRef}`);
      err.code = "port_not_found";
      throw err;
    }
    if (settingsPatch) {
      st.settings = normalizeSettings(settingsPatch, st.settings);
      this.defaults = { ...st.settings };
      if (st.serial && st.serial.isOpen && typeof st.serial.update === "function") {
        await new Promise((resolve) =>
          st.serial.update(serialOptions(st, st.settings), () => resolve()),
        );
      }
    }
    if (st.serial && st.serial.isOpen) return st;
    this._ensureEngine(st);
    if (st.openPromise) {
      await st.openPromise;
      return st;
    }
    st.openPromise = (async () => {
      const serial = await this._factory(st);
      st.serial = serial;
      serial.on("data", (chunk) => this._onData(st, chunk));
      serial.on("error", () => {});
      serial.on("close", () => {
        for (const fn of st.closeHandlers) {
          try {
            fn();
          } catch (_) {}
        }
      });
      if (!serial.isOpen) {
        await new Promise((resolve, reject) => {
          serial.open((err) => (err ? reject(err) : resolve()));
        });
      }
      st.missing = false;
      return st;
    })();
    try {
      await st.openPromise;
    } finally {
      st.openPromise = null;
    }
    return st;
  }

  _onData(st, chunk) {
    if (!chunk || chunk.length === 0) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const offset = st.log.rxOffset;
    const before = st.ring.used;
    st.ring.push(buf);
    if (st.ring.droppedBytes > before) {
      st.overflowEvents += 1;
      st.overflowBytes += st.ring.droppedBytes - before;
    }
    st.log.pushRx(buf, offset);
    if (st.capture) st.capture.onData(buf);
    for (const fn of st.wake) {
      try {
        fn();
      } catch (_) {}
    }
  }

  _waitForData(st, ms, signal) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        st.wake.delete(onWake);
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", finish);
        resolve();
      };
      const onWake = () => finish();
      st.wake.add(onWake);
      const timer = setTimeout(finish, Math.max(0, ms));
      timer.unref?.();
      if (signal) signal.addEventListener("abort", finish, { once: true });
    });
  }

  _readResult(st, slice, reason, matched = false) {
    return {
      data: slice.data,
      offset_from: slice.from,
      offset_to: slice.to,
      next_offset: slice.next,
      matched,
      stopped_reason: reason,
      gap: slice.gap,
      ring_start_offset: slice.ringStart,
      ring_end_offset: slice.ringEnd,
    };
  }

  /**
   * 带等待的 pull。返回 { data, offset_*, matched, stopped_reason, gap, ... }
   */
  async read(portRef, params = {}, signal) {
    const st = await this.openPort(portRef);
    const from = Number.isFinite(params.from_offset) ? params.from_offset : st.log.rxOffset;
    const minBytes = Number.isFinite(params.min_bytes) ? params.min_bytes : 1;
    const maxBytes = Number.isFinite(params.max_bytes) ? params.max_bytes : null;
    const holdClamped = Number(params.max_wait_ms) > this.maxHoldMs;
    const waitMs = Math.min(
      Number.isFinite(params.max_wait_ms) ? params.max_wait_ms : 5000,
      this.maxHoldMs,
    );
    const idleMs = Number.isFinite(params.idle_timeout_ms) ? params.idle_timeout_ms : 300;
    const budgetMs = Number.isFinite(params.budget_ms) ? params.budget_ms : waitMs;
    const match = params.match_b64 ? Buffer.from(params.match_b64, "base64") : null;
    const deadline = Date.now() + Math.max(budgetMs, waitMs);
    let cursor = from;
    let got = 0;
    let idleDeadline = null;
    for (;;) {
      const slice = st.ring.read(cursor, maxBytes);
      if (slice.data.length > 0) {
        if (match) {
          const abs = st.ring.indexOf(match, slice.from);
          if (abs >= 0) {
            const end = abs + match.length;
            const sub = st.ring.read(slice.from, end - slice.from);
            return {
              ...this._readResult(st, sub, "match", true),
              hold_clamped: holdClamped,
            };
          }
        }
        got += slice.data.length;
        cursor = slice.next;
        if (!match && got >= minBytes) {
          const all = st.ring.read(from, cursor - from);
          return { ...this._readResult(st, all, "min_bytes"), hold_clamped: holdClamped };
        }
        if (maxBytes && got >= maxBytes) {
          const all = st.ring.read(from, cursor - from);
          return { ...this._readResult(st, all, "max_bytes"), hold_clamped: holdClamped };
        }
        if (idleDeadline == null) idleDeadline = Date.now() + idleMs;
        if (!match) continue;
      }
      const now = Date.now();
      if (now >= deadline) {
        const all = st.ring.read(from, cursor - from);
        return {
          ...this._readResult(st, all, got > 0 ? "budget" : "idle"),
          hold_clamped: holdClamped,
        };
      }
      if (idleDeadline != null && now >= idleDeadline && got > 0) {
        const all = st.ring.read(from, cursor - from);
        return { ...this._readResult(st, all, "idle"), hold_clamped: holdClamped };
      }
      const waitUntil = Math.min(
        deadline,
        idleDeadline != null ? idleDeadline : deadline,
        now + 1000,
      );
      await this._waitForData(st, Math.max(0, waitUntil - now), signal);
      // 等待后重新进入循环；若期间无数据且已到 idle 阈值则退出
      if (idleDeadline != null && Date.now() >= idleDeadline && got > 0) {
        const all = st.ring.read(from, cursor - from);
        return { ...this._readResult(st, all, "idle"), hold_clamped: holdClamped };
      }
    }
  }

  async write(portRef, data, opId) {
    const st = await this.openPort(portRef);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (opId) {
      const dedupe = st._dedupe || (st._dedupe = new Map());
      const hit = dedupe.get(opId);
      if (hit && Date.now() - hit.at < 60000) {
        return { ...hit.result, deduped: true };
      }
      if (dedupe.size > 128) dedupe.delete(dedupe.keys().next().value);
      const txOffset = st.log.txOffset;
      const txLogSeq = st.log.pushTx(buf, txOffset);
      await new Promise((resolve, reject) => {
        st.serial.write(buf, (err) => (err ? reject(err) : resolve()));
      });
      const result = {
        bytes_written: buf.length,
        tx_offset: txOffset,
        tx_log_seq: txLogSeq,
        deduped: false,
      };
      dedupe.set(opId, { at: Date.now(), result });
      return result;
    }
    const txOffset = st.log.txOffset;
    const txLogSeq = st.log.pushTx(buf, txOffset);
    await new Promise((resolve, reject) => {
      st.serial.write(buf, (err) => (err ? reject(err) : resolve()));
    });
    return { bytes_written: buf.length, tx_offset: txOffset, tx_log_seq: txLogSeq, deduped: false };
  }

  async transact(portRef, params = {}, signal) {
    const st = await this.openPort(portRef);
    const barrier = st.log.rxOffset;
    const w = await this.write(portRef, Buffer.from(params.data_b64 || "", "base64"), params.op_id);
    const r = await this.read(
      portRef,
      {
        ...params,
        from_offset: barrier,
        max_wait_ms: params.max_wait_ms ?? 2000,
      },
      signal,
    );
    return {
      ...r,
      barrier_offset: barrier,
      tx_offset: w.tx_offset,
      tx_log_seq: w.tx_log_seq,
      deduped: w.deduped,
    };
  }

  async setLines(portRef, { dtr, rts }) {
    const st = await this.openPort(portRef);
    const opts = {};
    if (typeof dtr === "boolean") opts.dtr = dtr;
    if (typeof rts === "boolean") opts.rts = rts;
    if (Object.keys(opts).length === 0) return { dtr: null, rts: null };
    await new Promise((resolve, reject) => {
      st.serial.set(opts, (err) => (err ? reject(err) : resolve()));
    });
    return { dtr: opts.dtr ?? null, rts: opts.rts ?? null };
  }

  async break(portRef, durationMs = 300) {
    const st = await this.openPort(portRef);
    await new Promise((resolve, reject) => {
      st.serial.set({ brk: true }, (err) => (err ? reject(err) : resolve()));
    });
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, durationMs)));
    await new Promise((resolve, reject) => {
      st.serial.set({ brk: false }, (err) => (err ? reject(err) : resolve()));
    });
    return { duration_ms: durationMs };
  }

  ringStats(st) {
    return {
      bytes: st.ring.capacity,
      used: st.ring.used,
      start_offset: st.ring.startOffset,
      end_offset: st.ring.endOffset,
      dropped_bytes: st.ring.droppedBytes,
    };
  }

  close() {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    for (const st of this.ports.values()) {
      try {
        st.serial?.close?.();
      } catch (_) {}
      try {
        st.log?.store?.close();
      } catch (_) {}
    }
    this.ports.clear();
  }

  set maxHoldMs(v) {
    this._maxHoldMs = Math.max(1000, Number(v) || 10000);
  }

  get maxHoldMs() {
    return this._maxHoldMs ?? 10000;
  }
}
