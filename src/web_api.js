// Web UI 后端：给 `serial-hub-mcp --http` 自带的调试页面用。
//
// 只做三件事：
//   GET  /api/connections          当前进程里已打开的连接（含状态）
//   POST /api/write                复用 write 工具发数据
//   GET  /api/stream?connection_id SSE 推送该连接的实时收发数据
//
// 鉴权在 sdk/http.js 统一做（Bearer token），这里只相信已授权的请求。

import { StringDecoder } from "node:string_decoder";
import { invokeTool } from "./sdk/tool.js";

const MAX_BODY = 1024 * 1024;
const MAX_BUFFERED = 4 * 1024 * 1024;
// 高码率串口（如 921600）每秒能来上千个小 chunk。按 80ms 合并成一批再推，
// 浏览器事件数从 ~1600/s 降到 ~10/s，同时保留每个方向的第一块时间戳。
const STREAM_FLUSH_MS = 80;
const STREAM_MAX_PENDING = 256 * 1024;
const TEXT_PREVIEW = 4096;
const NOISE_FLUSH_MS = 1000;

/** 休眠/悬空 UART 常见 0x00/0xff/空白洪水；这类字节不往页面灌正文。 */
function isIdleByte(b) {
  return b === 0x00 || b === 0xff || b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;
}

function summarizeParts(parts) {
  const buf = Buffer.concat(parts);
  let opaque = buf.length > 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (!isIdleByte(buf[i])) {
      opaque = false;
      break;
    }
  }
  return {
    total: buf.length,
    opaque,
    byte: buf.length ? buf[0] : 0,
    text: opaque ? "" : buf.subarray(0, TEXT_PREVIEW).toString("utf8"),
    truncated: Math.max(0, buf.length - TEXT_PREVIEW),
  };
}

function json(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`request body too large (> ${limit})`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e.message}`));
      }
    });
    req.on("error", reject);
  });
}

function errorPayload(err) {
  return { ok: false, error: { message: (err && err.message) || String(err) } };
}

function statusFor(err) {
  return err && (err.name === "ZodError" || /invalid JSON|too large/.test(err.message)) ? 400 : 500;
}

function formatTs(ts) {
  return Number.isFinite(ts) ? ts : Date.now();
}

/**
 * @param {object} opts
 * @param {import("./connection.js").ConnectionManager} opts.manager
 * @param {object[]} opts.tools buildTools 产出的工具描述
 * @param {object} [opts.queue] keyedSerialQueue（与 MCP 共用）
 * @returns {(req:import("node:http").IncomingMessage, res:import("node:http").ServerResponse, url:URL)=>Promise<boolean>}
 */
export function createWebApi({ manager, tools, queue }) {
  const byName = new Map((tools || []).map((t) => [t.name, t]));

  async function callTool(name, args) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`工具不可用: ${name}`);
    return invokeTool(tool, args, queue);
  }

  // 交互式终端：按键必须绕开 per-connection 队列，否则 agent 的 receive 会卡住打字。
  async function callToolNoQueue(name, args) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`工具不可用: ${name}`);
    return invokeTool(tool, args, null);
  }

  function stream(req, res, url) {
    const connectionId = url.searchParams.get("connection_id");
    if (!connectionId)
      return json(res, 400, { ok: false, error: { message: "缺少 connection_id" } });
    const conn = manager.get(connectionId);
    if (!conn) return json(res, 404, { ok: false, error: { message: "连接不存在" } });

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");

    let done = false;
    let unsub = null;
    let ping = null;
    let flushTimer = null;
    let pending = [];
    let pendingBytes = 0;
    let noiseBytes = 0;
    let noiseByte = null;
    let noiseTimer = null;

    const send = (event, data) => {
      if (done || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const cleanup = () => {
      if (done) return;
      done = true;
      if (ping) clearInterval(ping);
      if (flushTimer) clearTimeout(flushTimer);
      if (noiseTimer) clearTimeout(noiseTimer);
      ping = null;
      flushTimer = null;
      noiseTimer = null;
      pending = [];
      pendingBytes = 0;
      noiseBytes = 0;
      noiseByte = null;
      if (unsub) {
        try {
          unsub();
        } catch (_) {
          /* ignore */
        }
        unsub = null;
      }
    };

    const finish = (event, data) => {
      send(event, data);
      cleanup();
      if (!res.writableEnded) res.end();
    };

    const flush = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (done || pending.length === 0) return;
      if (res.writableLength > MAX_BUFFERED) {
        pending = [];
        pendingBytes = 0;
        return finish("overflow", { ts: Date.now(), buffered: res.writableLength });
      }
      const items = [];
      let noise = 0;
      let noiseLast = null;
      let noiseTs = null;
      for (const p of pending) {
        const s = summarizeParts(p.parts);
        if (s.opaque) {
          noise += s.total;
          noiseLast = s.byte;
          noiseTs = p.ts;
          continue;
        }
        const item = {
          ts: p.ts,
          ts_last: p.tsLast,
          dir: p.dir,
          bytes: s.total,
          text: s.text,
        };
        if (s.truncated > 0) item.truncated = s.truncated;
        items.push(item);
      }
      pending = [];
      pendingBytes = 0;
      if (noise > 0) {
        noiseBytes += noise;
        noiseByte = noiseLast;
        scheduleNoise(noiseTs);
      }
      if (items.length === 1) send("data", items[0]);
      else if (items.length > 1) send("data", { items });
    };

    const scheduleNoise = (ts) => {
      if (noiseTimer || done) return;
      noiseTimer = setTimeout(() => {
        noiseTimer = null;
        if (done || noiseBytes <= 0) return;
        send("noise", { ts: ts ?? Date.now(), bytes: noiseBytes, byte: noiseByte ?? 0 });
        noiseBytes = 0;
        noiseByte = null;
      }, NOISE_FLUSH_MS);
      noiseTimer.unref?.();
    };

    const queue = (evt) => {
      if (done || !evt || !evt.chunk) return;
      const chunk = evt.chunk;
      const dir = evt.dir === "tx" ? "tx" : "rx";
      const ts = formatTs(evt.ts);
      const last = pending[pending.length - 1];
      if (last && last.dir === dir) {
        last.parts.push(chunk);
        last.bytes += chunk.length;
        last.tsLast = ts;
      } else {
        pending.push({ dir, ts, tsLast: ts, bytes: chunk.length, parts: [chunk] });
      }
      pendingBytes += chunk.length;
      if (pendingBytes >= STREAM_MAX_PENDING) flush();
      else if (!flushTimer) {
        flushTimer = setTimeout(flush, STREAM_FLUSH_MS);
        flushTimer.unref?.();
      }
    };

    try {
      send("hello", { connection_id: connectionId, status: conn.status() });
    } catch (err) {
      return finish("error", errorPayload(err));
    }

    unsub = manager.subscribe(connectionId, (evt) => {
      if (done) return;
      if (evt && evt.type === "closed") {
        flush();
        return finish("closed", { ts: formatTs(evt.ts) });
      }
      queue(evt);
    });

    if (!unsub) return finish("error", { ok: false, error: { message: "该连接不支持实时订阅" } });

    ping = setInterval(() => {
      if (!done) res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    }, 15000);
    ping.unref?.();

    res.on("close", cleanup);
    return undefined;
  }

  /**
   * 真终端模式的原始输出流：不做时间戳、不折叠正文、不截断；
   * 只丢弃纯 0x00/0xFF（休眠/悬空 UART 的不可见洪水）。约 30ms 合并一次。
   */
  function terminal(req, res, url) {
    const connectionId = url.searchParams.get("connection_id");
    if (!connectionId)
      return json(res, 400, { ok: false, error: { message: "缺少 connection_id" } });
    const conn = manager.get(connectionId);
    if (!conn) return json(res, 404, { ok: false, error: { message: "连接不存在" } });

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");

    const decoder = new StringDecoder("utf8");
    let done = false;
    let unsub = null;
    let ping = null;
    let flushTimer = null;
    let pending = [];
    let pendingBytes = 0;

    const send = (event, data) => {
      if (done || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const cleanup = () => {
      if (done) return;
      done = true;
      if (ping) clearInterval(ping);
      if (flushTimer) clearTimeout(flushTimer);
      ping = null;
      flushTimer = null;
      pending = [];
      pendingBytes = 0;
      if (unsub) {
        try {
          unsub();
        } catch (_) {
          /* ignore */
        }
        unsub = null;
      }
    };

    const finish = (event, data) => {
      send(event, data);
      cleanup();
      if (!res.writableEnded) res.end();
    };

    const flush = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (done || pending.length === 0) return;
      if (res.writableLength > MAX_BUFFERED) {
        pending = [];
        pendingBytes = 0;
        return finish("overflow", { buffered: res.writableLength });
      }
      const text = decoder.write(Buffer.concat(pending));
      pending = [];
      pendingBytes = 0;
      if (text) send("data", { text });
    };

    const queue = (evt) => {
      if (done || !evt || !evt.chunk) return;
      // 真终端只回显设备侧（RX）。把 TX 也写回 xterm 会在设备本来就有回显时
      // 变成“双份字符”（hheellpp）；要看 TX 用日志视图，那里有方向标注。
      if (evt.dir === "tx") return;
      const chunk = evt.chunk;
      let noise = true;
      for (let i = 0; i < chunk.length; i += 1) {
        const b = chunk[i];
        if (b !== 0x00 && b !== 0xff) {
          noise = false;
          break;
        }
      }
      if (noise) return;
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes >= STREAM_MAX_PENDING) flush();
      else if (!flushTimer) {
        flushTimer = setTimeout(flush, 30);
        flushTimer.unref?.();
      }
    };

    try {
      send("hello", { connection_id: connectionId, status: conn.status() });
    } catch (err) {
      return finish("error", errorPayload(err));
    }

    unsub = manager.subscribe(connectionId, (evt) => {
      if (done) return;
      if (evt && evt.type === "closed") {
        flush();
        const tail = decoder.end();
        if (tail) send("data", { text: tail });
        return finish("closed", { ts: formatTs(evt.ts) });
      }
      queue(evt);
    });

    if (!unsub) return finish("error", { ok: false, error: { message: "该连接不支持实时订阅" } });

    ping = setInterval(() => {
      if (!done) res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    }, 15000);
    ping.unref?.();

    res.on("close", cleanup);
    return undefined;
  }

  return async function handle(req, res, url) {
    if (!url.pathname.startsWith("/api/")) return false;

    try {
      if (req.method === "GET" && url.pathname === "/api/connections") {
        json(res, 200, {
          ok: true,
          response: { connections: manager.list(), time: Date.now() },
        });
        return true;
      }

      if (req.method === "GET" && url.pathname === "/api/stream") {
        stream(req, res, url);
        return true;
      }

      if (req.method === "GET" && url.pathname === "/api/terminal") {
        terminal(req, res, url);
        return true;
      }

      if (req.method === "GET" && url.pathname === "/api/history") {
        const connectionId = url.searchParams.get("connection_id");
        if (!connectionId) {
          json(res, 400, { ok: false, error: { message: "缺少 connection_id" } });
          return true;
        }
        if (!manager.get(connectionId)) {
          json(res, 404, { ok: false, error: { message: "连接不存在" } });
          return true;
        }
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 500, 1), 1000);
        const args = { connection_id: connectionId, limit, order: "desc", include_hex: false };
        const rawSeq = url.searchParams.get("before_seq");
        const rawTs = url.searchParams.get("before_ts");
        if (rawSeq != null && Number.isFinite(Number(rawSeq))) {
          args.seq_to = Number(rawSeq) - 1;
        } else if (rawTs != null && Number.isFinite(Number(rawTs))) {
          args.time_to = Number(rawTs) - 1;
        }
        const payload = await callTool("log_query", args);
        const r = payload && payload.response ? payload.response : payload || {};
        const entries = (Array.isArray(r.entries) ? r.entries : [])
          .map((e) => ({
            seq: e.seq,
            ts: e.ts,
            dir: e.dir === "tx" ? "tx" : "rx",
            text: typeof e.line === "string" ? e.line : "",
            bytes: e.bytes ?? null,
          }))
          .reverse();
        json(res, 200, {
          ok: true,
          response: {
            entries,
            count: entries.length,
            earliest_seq: r.earliest_seq ?? null,
            truncated: Boolean(r.truncated),
          },
        });
        return true;
      }

      if (req.method === "POST" && url.pathname === "/api/dump") {
        const body = await readJson(req);
        const payload = await callTool("dump_to_file", body);
        json(res, 200, payload);
        return true;
      }

      // 页面上的「关闭标签」：直接调 close 工具，绕开队列（正在 receive 也不能拖住关闭）。
      if (req.method === "POST" && url.pathname === "/api/close") {
        const body = await readJson(req);
        if (typeof body.connection_id !== "string" || !body.connection_id) {
          json(res, 400, {
            ok: false,
            error: { message: "close 需要 connection_id 字符串" },
          });
          return true;
        }
        const payload = await callToolNoQueue("close", {
          connection_id: body.connection_id,
        });
        json(res, 200, payload);
        return true;
      }

      if (req.method === "POST" && url.pathname === "/api/write") {
        const body = await readJson(req);
        const payload = await callTool("write", body);
        json(res, 200, payload);
        return true;
      }

      if (req.method === "POST" && url.pathname === "/api/input") {
        const body = await readJson(req);
        if (typeof body.connection_id !== "string" || typeof body.data !== "string") {
          json(res, 400, {
            ok: false,
            error: { message: "input 需要 connection_id 和 data 字符串" },
          });
          return true;
        }
        const payload = await callToolNoQueue("write", {
          connection_id: body.connection_id,
          data: body.data,
          encoding: body.encoding || "utf8",
          newline: "none",
        });
        json(res, 200, payload);
        return true;
      }

      json(res, 404, { ok: false, error: { message: `not found: ${url.pathname}` } });
      return true;
    } catch (err) {
      json(res, statusFor(err), errorPayload(err));
      return true;
    }
  };
}
