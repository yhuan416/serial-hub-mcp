// ByteRing — 绝对偏移的环形字节缓冲。
//
// 语义与远端协议一致：rx_offset 是「已收到的字节数」（0-based），
// from_offset=N 返回位置 >= N 的字节；缓冲区溢出后 startOffset 前移，
// 读取 fromOffset < startOffset 时由调用方标记 gap。

export class ByteRing {
  constructor(capacity) {
    const cap = Math.max(1024, Math.floor(capacity) || 0);
    this.capacity = cap;
    this.buf = Buffer.allocUnsafe(cap);
    this.startOffset = 0; // 仍保留的最早字节的绝对偏移
    this.endOffset = 0; // 已写入的总字节数（下一个字节的绝对偏移）
    this.droppedBytes = 0;
  }

  get used() {
    return this.endOffset - this.startOffset;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (data.length >= this.capacity) {
      // 只保留最后 capacity 字节
      const keep = data.subarray(data.length - this.capacity);
      keep.copy(this.buf, 0);
      this.droppedBytes += this.used + (data.length - this.capacity);
      this.endOffset += data.length;
      this.startOffset = this.endOffset - this.capacity;
      return;
    }
    const writePos = this.endOffset % this.capacity;
    const first = Math.min(data.length, this.capacity - writePos);
    data.copy(this.buf, writePos, 0, first);
    if (first < data.length) data.copy(this.buf, 0, first);
    this.endOffset += data.length;
    if (this.endOffset - this.startOffset > this.capacity) {
      this.droppedBytes += this.endOffset - this.startOffset - this.capacity;
      this.startOffset = this.endOffset - this.capacity;
    }
  }

  /**
   * 读取 [fromOffset, fromOffset+maxBytes) 的数据（拷贝）。
   * fromOffset 小于 startOffset 时自动钳到 startOffset，并返回 gap=true。
   * @returns {{data:Buffer, from:number, to:number, next:number, gap:boolean, ringStart:number, ringEnd:number}}
   */
  read(fromOffset, maxBytes) {
    const ringStart = this.startOffset;
    const ringEnd = this.endOffset;
    let from = Number.isFinite(fromOffset) ? Math.floor(fromOffset) : ringStart;
    let gap = false;
    if (from < ringStart) {
      from = ringStart;
      gap = true;
    }
    if (from > ringEnd) from = ringEnd;
    let to = maxBytes && maxBytes > 0 ? Math.min(ringEnd, from + Math.floor(maxBytes)) : ringEnd;
    if (to < from) to = from;
    return {
      data: this._slice(from, to),
      from,
      to,
      next: to,
      gap,
      ringStart,
      ringEnd,
    };
  }

  /** 丢弃已有内容并从 offset 重新开始（用于 capture gap）。 */
  resetAt(offset) {
    const v = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    this.startOffset = v;
    this.endOffset = v;
  }

  _slice(from, to) {
    const len = Math.max(0, to - from);
    if (len === 0) return Buffer.alloc(0);
    const out = Buffer.allocUnsafe(len);
    const pos = from % this.capacity;
    const first = Math.min(len, this.capacity - pos);
    this.buf.copy(out, 0, pos, pos + first);
    if (first < len) this.buf.copy(out, first, 0, len - first);
    return out;
  }

  /** 在 [fromOffset, endOffset) 中查找 needle，返回绝对偏移或 -1。 */
  indexOf(needle, fromOffset = this.startOffset) {
    if (!needle || needle.length === 0) return -1;
    let from = Math.max(this.startOffset, Number.isFinite(fromOffset) ? fromOffset : 0);
    const end = this.endOffset;
    if (from > end) return -1;
    const n = Buffer.isBuffer(needle) ? needle : Buffer.from(needle);
    // 分块扫描，避免整环拷贝（块之间有 n-1 字节重叠）
    const chunkSize = 64 * 1024;
    let pos = from;
    let carry = Buffer.alloc(0);
    while (pos < end) {
      const piece = this._slice(pos, Math.min(end, pos + chunkSize));
      const hay = carry.length ? Buffer.concat([carry, piece]) : piece;
      const idx = hay.indexOf(n);
      if (idx >= 0) {
        const abs = pos - carry.length + idx;
        if (abs >= from) return abs;
      }
      carry =
        n.length > 1 ? hay.subarray(Math.max(0, hay.length - (n.length - 1))) : Buffer.alloc(0);
      pos += piece.length;
      if (piece.length === 0) break;
    }
    return -1;
  }
}
