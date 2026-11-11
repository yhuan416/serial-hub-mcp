// NDJSON RPC 客户端：一行一个 JSON 请求/响应，按 id 关联。
//
// 传输无关：只依赖 node:net 风格的 socket（write 字符串、on('data'|'error'|'close')）。
// v0 规定每条连接同一时刻只有一个 in-flight；本类不做并发限制，由上层（hub 按连接串行）保证。

import { EventEmitter } from "node:events";

export class RpcTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.code = "timeout";
  }
}

export class RpcRemoteError extends Error {
  constructor(code, message) {
    super(message || code || "remote error");
    this.code = code || "remote_error";
  }
}

export class RpcClient extends EventEmitter {
  constructor(socket, { defaultTimeoutMs = 15000, maxLineBytes = 8 * 1024 * 1024 } = {}) {
    super();
    this.socket = socket;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxLineBytes = maxLineBytes;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.closed = false;

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("error", (err) => this._failAll(err));
    socket.on("close", () => this._failAll(new Error("链路已关闭")));
    socket.on("end", () => this._failAll(new Error("链路已结束")));
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        this.emit("protocolError", line);
        continue;
      }
      this._onMessage(msg);
    }
    if (this.buffer.length > this.maxLineBytes) {
      this._failAll(new Error("响应行过长"));
      try {
        this.socket.destroy();
      } catch (_) {
        /* ignore */
      }
    }
  }

  _onMessage(msg) {
    const id = msg && msg.id;
    if (typeof id === "number" && this.pending.has(id)) {
      const p = this.pending.get(id);
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result ?? {});
      else
        p.reject(new RpcRemoteError(msg.error && msg.error.code, msg.error && msg.error.message));
      return;
    }
    // 非应答帧（v0 不应出现推送；保留给将来）
    this.emit("event", msg);
  }

  /**
   * 发一条请求并等待应答。
   * @param {string} op
   * @param {object} [params]
   * @param {{timeoutMs?:number}} [opts]
   */
  request(op, params = {}, opts = {}) {
    if (this.closed) return Promise.reject(new Error("链路已关闭"));
    const id = this.nextId++;
    const timeout = opts.timeoutMs ?? this.defaultTimeoutMs;
    const line = JSON.stringify({ id, op, ...params }) + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(`请求超时: ${op}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(line);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  _failAll(err) {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.emit("close", err);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("链路已关闭"));
    }
    this.pending.clear();
    try {
      this.socket.end();
    } catch (_) {
      /* ignore */
    }
    try {
      this.socket.destroy();
    } catch (_) {
      /* ignore */
    }
    this.emit("close");
  }
}
