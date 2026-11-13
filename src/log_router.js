// LogRouter —— 按 connection_id 路由日志后端。
//
// 目的：hub 同时对接本地/远端串口时，本地连接仍落现有 LogStore，
// 远端连接的日志在 host 本地缓存。Connection 只认一个
// LogBackend 对象，因此这里实现对 Connection 的同一组方法，内部按 id 分派。
//
// LogBackend 接口（Connection 调用）：
//   addData(conn, buf) / addTx(conn, buf) / unregister(conn) / currentPartial(conn)
// 查询接口（tools/log.js 调用）：
//   query(opts) / stats(conn?) / clear(conn?)

export class LogRouter {
  /**
   * @param {object|null} localStore 本地 LogStore；作为未绑定连接的默认后端
   */
  constructor(localStore) {
    this.localStore = localStore || null;
    this.byConn = new Map();
  }

  /** 为某连接绑定后端；backend 为空则解除绑定（回落到本地默认）。 */
  bind(connection_id, backend) {
    if (!connection_id) return;
    if (backend) this.byConn.set(connection_id, backend);
    else this.byConn.delete(connection_id);
  }

  unbind(connection_id) {
    this.byConn.delete(connection_id);
  }

  backendFor(connection_id) {
    return this.byConn.get(connection_id) ?? this.localStore;
  }

  // ── Connection 侧接口（按 id 分派）─────────────────────
  addData(connection_id, buf) {
    const b = this.backendFor(connection_id);
    if (b) b.addData(connection_id, buf);
  }

  addTx(connection_id, buf) {
    const b = this.backendFor(connection_id);
    if (b) b.addTx(connection_id, buf);
  }

  unregister(connection_id) {
    const b = this.backendFor(connection_id);
    if (b) b.unregister(connection_id);
    this.byConn.delete(connection_id);
  }

  currentPartial(connection_id) {
    const b = this.backendFor(connection_id);
    return b ? b.currentPartial(connection_id) : null;
  }

  // ── 查询侧接口（tools/log.js）──────────────────────────
  // 指定连接时路由到该连接的后端；省略 connection_id 时聚合本地 + 所有远端后端。
  query(opts = {}) {
    const id = opts.connection_id;
    if (id) {
      const b = this.backendFor(id);
      if (!b) throw new Error("日志功能未启用");
      return b.query(opts);
    }
    return this._queryAll(opts);
  }

  async _queryAll(opts) {
    const entries = [];
    const sources = [];
    const errors = [];
    if (this.localStore) {
      try {
        const r = await this.localStore.query(opts);
        entries.push(...(Array.isArray(r.entries) ? r.entries : []));
        sources.push(this._sourceSummary(null, "local", "host", r));
      } catch (err) {
        errors.push({ connection_id: null, transport: "local", error: err.message });
      }
    }
    for (const [cid, b] of this.byConn) {
      if (!b || b === this.localStore) continue;
      try {
        const r = await b.query({ ...opts, connection_id: cid });
        const list = Array.isArray(r.entries) ? r.entries : [];
        for (const e of list) entries.push({ ...e, connection_id: cid });
        sources.push(this._sourceSummary(cid, "remote", r.source ?? "device", r));
      } catch (err) {
        errors.push({ connection_id: cid, transport: "remote", error: err.message });
      }
    }
    if (!this.localStore && this.byConn.size === 0) throw new Error("日志功能未启用");
    return {
      scope: "all",
      entries,
      count: entries.length,
      truncated: sources.some((s) => s.truncated),
      sources,
      errors,
    };
  }

  _sourceSummary(connection_id, transport, source, r) {
    return {
      connection_id,
      transport,
      source,
      count: r.count ?? 0,
      truncated: Boolean(r.truncated),
      earliest_seq: r.earliest_seq ?? null,
      ram_earliest_seq: r.ram_earliest_seq ?? null,
      sd_earliest_seq: r.sd_earliest_seq ?? null,
      storage: r.storage,
    };
  }

  stats(connection_id) {
    if (connection_id) {
      const b = this.backendFor(connection_id);
      if (!b) throw new Error("日志功能未启用");
      return b.stats(connection_id);
    }
    return this._statsAll();
  }

  async _statsAll() {
    const remote = [];
    const sources = [];
    const errors = [];
    let local = null;
    if (this.localStore) {
      try {
        local = await this.localStore.stats();
        sources.push({ connection_id: null, transport: "local", source: "host", ...local });
      } catch (err) {
        errors.push({ connection_id: null, transport: "local", error: err.message });
      }
    }
    for (const [cid, b] of this.byConn) {
      if (!b || b === this.localStore) continue;
      try {
        const r = await b.stats(cid);
        remote.push(r);
        sources.push({
          connection_id: cid,
          transport: "remote",
          source: r.source ?? "device",
          ...r,
        });
      } catch (err) {
        errors.push({ connection_id: cid, transport: "remote", error: err.message });
      }
    }
    if (!local && remote.length === 0 && errors.length === 0) {
      throw new Error("日志功能未启用");
    }
    const total =
      (local?.total ?? 0) +
      remote.reduce((sum, r) => sum + (Number(r.total ?? r.index_count) || 0), 0);
    return {
      scope: "all",
      ...(local || {}),
      total,
      remote,
      sources,
      errors,
    };
  }

  clear(connection_id, opts = {}) {
    if (connection_id) {
      const b = this.backendFor(connection_id);
      if (!b) throw new Error("日志功能未启用");
      return b.clear(connection_id, opts);
    }
    return this._clearAll(opts);
  }

  async _clearAll(opts = {}) {
    if (opts.confirm !== true) {
      throw new Error("全量清空需要 confirm=true（会清本地日志并清空所有远端设备当前日志）");
    }
    const cleared = [];
    const errors = [];
    if (this.localStore) {
      try {
        const r = await this.localStore.clear();
        cleared.push({ connection_id: null, transport: "local", ...r });
      } catch (err) {
        errors.push({ connection_id: null, transport: "local", error: err.message });
      }
    }
    for (const [cid, b] of this.byConn) {
      if (!b || b === this.localStore) continue;
      try {
        const r = await b.clear(cid, opts);
        cleared.push({ connection_id: cid, transport: "remote", ...r });
      } catch (err) {
        errors.push({ connection_id: cid, transport: "remote", error: err.message });
      }
    }
    return { scope: "all", cleared, errors };
  }

  export(opts = {}) {
    const id = opts.connection_id;
    const b = id ? this.backendFor(id) : this.localStore;
    if (!b) throw new Error("日志功能未启用");
    if (typeof b.export !== "function") {
      throw new Error("当前连接不支持 log_export（需要远端 SD 权威日志；本地请用 dump_to_file）");
    }
    return b.export(opts);
  }

  events(connection_id, opts = {}) {
    const b = connection_id ? this.backendFor(connection_id) : this.localStore;
    if (!b) throw new Error("日志功能未启用");
    if (typeof b.events !== "function") {
      throw new Error("当前连接不支持 event_query（需要远端设备的事件日志）");
    }
    return b.events(opts);
  }

  sync(opts = {}) {
    const id = opts.connection_id;
    if (!id) throw new Error("log_sync 需要 connection_id（仅远端连接）");
    const b = this.backendFor(id);
    if (!b) throw new Error("日志功能未启用");
    if (typeof b.sync !== "function") {
      throw new Error("当前连接不支持 log_sync（需要远端 SD 权威日志）");
    }
    return b.sync(opts);
  }
}
