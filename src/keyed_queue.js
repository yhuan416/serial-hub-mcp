// 按 key 串行的队列：hub 场景下关键。
//
// 同一 connection_id 的调用严格串行（该连接的字节游标/等待器非并发安全）；
// 不同 connection_id 之间互不阻塞（否则一台设备的长 receive 会堵死整个 hub）。
// key 为空时归入全局队列（list_ports/open/profile_*/service_info/日志全查等）。

export function keyedSerialQueue() {
  const tails = new Map();

  function run(key, fn) {
    const k = key == null || key === "" ? "__global__" : String(key);
    const prev = tails.get(k) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    tails.set(k, tail);
    // 队尾跑完后若没有新任务挂上，清掉键避免长期累积。
    tail.finally(() => {
      if (tails.get(k) === tail) tails.delete(k);
    });
    return next;
  }

  return { run, size: () => tails.size };
}
