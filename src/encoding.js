// 编码/解码 helper：把串口工具的入参 data 字符串转成 Buffer，把 Buffer 转回字符串展示。
// 支持 UTF-8 文本、hex（允许空格/连续写）、base64 三种编码。

const HEX_RE = /^[0-9a-fA-F\s\t]+$/;

/**
 * 把入参 data 转成 Buffer。
 * @param {string|Buffer|{hex?:string,base64?:string,text?:string}} data
 * @param {'utf8'|'hex'|'base64'} [encoding]
 * @returns {Buffer}
 */
function toBuffer(data, encoding) {
  if (Buffer.isBuffer(data)) return data;

  // 对象形式 {hex:"AF 12"} / {base64:"..."} / {text:"..."}，显式指定优先
  if (data && typeof data === "object") {
    if (typeof data.hex === "string") return hexToBuffer(data.hex);
    if (typeof data.base64 === "string") return Buffer.from(data.base64, "base64");
    if (typeof data.text === "string") return Buffer.from(data.text, "utf8");
    throw new Error("data 对象必须是 {hex}/{base64}/{text} 之一");
  }

  if (typeof data !== "string") {
    throw new Error("data 必须是字符串、Buffer 或 {hex}/{base64}/{text} 对象");
  }

  switch (encoding) {
    case "hex":
      return hexToBuffer(data);
    case "base64":
      return Buffer.from(data, "base64");
    case "utf8":
    case "text":
    default:
      return Buffer.from(data, "utf8");
  }
}

/**
 * 解析 hex 字符串为 Buffer。允许 "AF 12" / "AF12" / 末尾偶数字符补齐。
 * 非法 hex 会抛错，避免静默错发。
 * @param {string} s
 * @returns {Buffer}
 */
function hexToBuffer(s) {
  const cleaned = String(s).replace(/[\s\t]+/g, "");
  if (cleaned.length === 0) return Buffer.alloc(0);
  if (!HEX_RE.test(cleaned)) {
    throw new Error(`非法 hex 字符: "${s}"`);
  }
  // 奇数长度补 0，容忍 "AF" 与 "A" 之类，但更倾向报错可读
  const normalized = cleaned.length % 2 === 0 ? cleaned : `0${cleaned}`;
  return Buffer.from(normalized, "hex");
}

/**
 * 把 Buffer 转成可读字符串用于展示。
 * @param {Buffer} buf
 * @param {'utf8'|'hex'|'base64'} [encoding]
 * @returns {string}
 */
function toDisplay(buf, encoding) {
  if (!buf || buf.length === 0) return "";
  switch (encoding) {
    case "hex":
      return buf.toString("hex") + `(len=${buf.length})`;
    case "base64":
      return buf.toString("base64");
    case "utf8":
    case "text":
    default: {
      // 尝试 UTF-8 解码，非文本字节退化为 hex 展示
      const text = buf.toString("utf8");
      if (/[\uFFFD]/.test(text)) {
        return `hex=${buf.toString("hex")}(len=${buf.length})`;
      }
      return text;
    }
  }
}

/**
 * 按模式给发送 Buffer 追加上行终止符（规避"发字面 \\r\\n 被当命令"的坑）。
 * @param {Buffer} buf
 * @param {'none'|'cr'|'lf'|'crlf'} [mode]
 * @returns {Buffer}
 */
function appendNewline(buf, mode = "none") {
  switch (mode) {
    case "cr":
      return Buffer.concat([buf, Buffer.from([0x0d])]);
    case "lf":
      return Buffer.concat([buf, Buffer.from([0x0a])]);
    case "crlf":
      return Buffer.concat([buf, Buffer.from([0x0d, 0x0a])]);
    case "none":
    default:
      return buf;
  }
}

export { toBuffer, hexToBuffer, toDisplay, appendNewline };
