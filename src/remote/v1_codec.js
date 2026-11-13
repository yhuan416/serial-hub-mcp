// v1_codec.js — 远端串口协议 v1 的帧编解码（host 与 hub-server 共用）。
//
// 帧：magic "SH"(0x5348) | ver(1) | type(1) | flags(1) | rsv(1) | len(u32 LE) | payload
// 类型：HELLO/HELLO_ACK/CONTROL/DATA/ACK/EVENT/ERROR

const MAGIC0 = 0x53; // 'S'
const MAGIC1 = 0x48; // 'H'
const VER = 1;
const HDR = 10;

export const T = {
  HELLO: 1,
  HELLO_ACK: 2,
  CONTROL: 3,
  DATA: 4,
  ACK: 5,
  EVENT: 6,
  ERROR: 7,
};

export const FLAG_GAP = 1;
export const FLAG_BATCH = 4;

const DATA_HDR = 30;
const ACK_LEN = 21;

export function isV1Magic(buf) {
  return buf && buf.length >= 2 && buf[0] === MAGIC0 && buf[1] === MAGIC1;
}

export function encodeFrame(type, flags, payload) {
  const body = payload || Buffer.alloc(0);
  const out = Buffer.allocUnsafe(HDR + body.length);
  out[0] = MAGIC0;
  out[1] = MAGIC1;
  out[2] = VER;
  out[3] = type & 0xff;
  out[4] = flags & 0xff;
  out[5] = 0;
  out.writeUInt32LE(body.length >>> 0, 6);
  body.copy(out, HDR);
  return out;
}

export function encodeControl(obj) {
  return encodeFrame(T.CONTROL, 0, Buffer.from(JSON.stringify(obj), "utf8"));
}

export function encodeHelloAck(result) {
  return encodeFrame(T.HELLO_ACK, 0, Buffer.from(JSON.stringify(result), "utf8"));
}

export function encodeData({ slot, captureId, seq, offset, ts, flags, data }) {
  const raw = data || Buffer.alloc(0);
  const out = Buffer.allocUnsafe(DATA_HDR + raw.length);
  out[0] = slot & 0xff;
  out.writeBigUInt64LE(BigInt(captureId), 1);
  out.writeUInt32LE(seq >>> 0, 9);
  out.writeBigUInt64LE(BigInt(offset), 13);
  out.writeBigUInt64LE(BigInt(ts || 0), 21);
  out[29] = flags & 0xff;
  raw.copy(out, DATA_HDR);
  return encodeFrame(T.DATA, 0, out);
}

export function encodeAckFrame({ slot, captureId, offset, seq }) {
  const out = Buffer.allocUnsafe(ACK_LEN);
  out[0] = slot & 0xff;
  out.writeBigUInt64LE(BigInt(captureId), 1);
  out.writeBigUInt64LE(BigInt(offset), 9);
  out.writeUInt32LE(seq >>> 0, 17);
  return encodeFrame(T.ACK, 0, out);
}

export function encodeEvent(obj) {
  return encodeFrame(T.EVENT, 0, Buffer.from(JSON.stringify(obj), "utf8"));
}

export function encodeProtocolError(code, message) {
  return encodeFrame(T.ERROR, 0, Buffer.from(JSON.stringify({ code, message }), "utf8"));
}

/** 从字节流中切出完整帧；返回 frames 与剩余 buffer。 */
export function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= HDR) {
    if (buf[off] !== MAGIC0 || buf[off + 1] !== MAGIC1 || buf[off + 2] !== VER) {
      return { frames, rest: buf.subarray(off), error: "bad_frame" };
    }
    const type = buf[off + 3];
    const flags = buf[off + 4];
    const len = buf.readUInt32LE(off + 6);
    if (buf.length - off < HDR + len) break;
    frames.push({ type, flags, payload: buf.subarray(off + HDR, off + HDR + len) });
    off += HDR + len;
  }
  return { frames, rest: buf.subarray(off) };
}
