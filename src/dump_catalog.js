// hub 侧 dump 目录。文件只落在本进程缓存目录，对外只给 file_id 和相对下载路径。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PREVIEW_TAIL = 1536;

export function dumpsDir() {
  if (process.env.SERIAL_HUB_MCP_DUMPS_DIR) return process.env.SERIAL_HUB_MCP_DUMPS_DIR;
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "serial-hub-mcp", "dumps");
}

export function allocDumpFile(prefix = "dump") {
  const dir = dumpsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file_id = `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.log`;
  return {
    file_id,
    file: path.join(dir, file_id),
    download_path: `/dumps/${file_id}`,
  };
}

function tailPreview(fd, size) {
  const n = Math.min(PREVIEW_TAIL, size);
  if (n <= 0) return "";
  const tail = Buffer.alloc(n);
  fs.readSync(fd, tail, 0, n, size - n);
  return tail.toString("utf8");
}

export function sealDump(file, file_id) {
  if (!ID_RE.test(file_id)) throw new Error(`invalid file_id: ${file_id}`);
  if (!fs.existsSync(file)) throw new Error(`dump file missing: ${file_id}`);
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(64 * 1024);
    let off = 0;
    while (off < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - off), off);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      off += n;
    }
    return {
      file_id,
      bytes: size,
      sha256: hash.digest("hex"),
      download_path: `/dumps/${file_id}`,
      preview: tailPreview(fd, size),
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function publishDump(raw, file_id, file) {
  const sealed = sealDump(file, file_id);
  const { path: _path, file: _file, ...rest } = raw && typeof raw === "object" ? raw : {};
  return {
    ...rest,
    ...sealed,
    preview: rest.preview || sealed.preview,
    download_note:
      "GET <hub-origin>" +
      sealed.download_path +
      " ，Bearer 与 /mcp 相同。这是相对路径，不是 agent 本机文件。",
  };
}

export function resolveDump(fileId) {
  if (typeof fileId !== "string" || !ID_RE.test(fileId)) return null;
  let dir;
  try {
    dir = fs.realpathSync(dumpsDir());
  } catch {
    return null;
  }
  const abs = path.join(dir, fileId);
  if (!fs.existsSync(abs)) return null;
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return null;
  }
  if (real !== path.join(dir, path.basename(real))) return null;
  if (!real.startsWith(dir + path.sep)) return null;
  return real;
}
