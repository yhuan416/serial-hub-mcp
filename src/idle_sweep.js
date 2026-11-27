// 空闲连接回收：默认关闭，SERIAL_HUB_MCP_IDLE_CLOSE_MINUTES>0 时生效。
//
// 判定依据是 status().idle_ms（opened_at / last_rx_at / last_tx_at 里最新的一个）。
// 只关“完全没读写”的连接，正在 receive 等数据的连接在超时前不会被误伤。

export async function closeIdleConnections(manager, idleMs, { log = () => {} } = {}) {
  if (!(idleMs > 0) || !manager || typeof manager.list !== "function") return [];
  const closed = [];
  for (const status of manager.list()) {
    const idle = Number(status && status.idle_ms);
    if (!Number.isFinite(idle) || idle < idleMs) continue;
    const where = (status && (status.port || status.endpoint)) || "?";
    try {
      await manager.close(status.connection_id);
      closed.push(status.connection_id);
      log(
        `[idle-sweep] closed ${status.connection_id} (${where}, idle ${Math.round(idle / 1000)}s)`,
      );
    } catch (err) {
      log(
        `[idle-sweep] close ${status.connection_id} (${where}) failed: ${
          (err && err.message) || err
        }`,
      );
    }
  }
  return closed;
}

/**
 * 启动空闲回收定时器；minutes<=0 时直接返回 null（默认关闭）。
 * 返回 { stop, idleMs, intervalMs }，定时器 unref 不会拖住进程退出。
 */
export function startIdleSweep(manager, { minutes, intervalMs = 60_000, log } = {}) {
  const idleMs = Number(minutes) * 60_000;
  if (!(idleMs > 0)) return null;
  const write = typeof log === "function" ? log : (msg) => process.stderr.write(`${msg}\n`);
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void closeIdleConnections(manager, idleMs, { log: write }).finally(() => {
      running = false;
    });
  }, intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    idleMs,
    intervalMs,
  };
}
