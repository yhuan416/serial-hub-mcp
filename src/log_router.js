// LogRouter —— 按 connection_id 路由日志后端。
//
// 目的：hub 同时对接本地/远端串口时，本地连接仍落现有 LogStore，
// 远端连接落设备权威后端（RemoteLogStore，待实现）。Connection 只认一个
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
  // 指定连接时路由到该连接的后端；全查暂由本地后端承担（远端跨源聚合待实现）。
  query(opts = {}) {
    const id = opts.connection_id;
    const b = id ? this.backendFor(id) : this.localStore;
    if (!b) throw new Error("日志功能未启用");
    return b.query(opts);
  }

  stats(connection_id) {
    const b = connection_id ? this.backendFor(connection_id) : this.localStore;
    if (!b) throw new Error("日志功能未启用");
    return b.stats(connection_id);
  }

  clear(connection_id) {
    const b = connection_id ? this.backendFor(connection_id) : this.localStore;
    if (!b) throw new Error("日志功能未启用");
    return b.clear(connection_id);
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
}
