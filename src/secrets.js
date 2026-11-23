// 读取运行时 secret：优先 NAME，其次 NAME_FILE。
//
// NAME_FILE 用于 Docker/Kubernetes secrets：文件内容去掉首尾空白后作为值。
// 文件缺失或为空时抛错，避免悄悄生成/使用空 token。

import fs from "node:fs";

export function readSecret(name, { env = process.env } = {}) {
  if (!name) throw new Error("readSecret: name 必填");

  const direct = env[name];
  if (typeof direct === "string" && direct.length > 0) return direct;

  const fileVar = `${name}_FILE`;
  const file = env[fileVar];
  if (!file) return undefined;

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`无法读取 ${fileVar} (${file}): ${err.message}`);
  }
  const value = text.trim();
  if (!value) throw new Error(`${fileVar} 指向的文件为空: ${file}`);
  return value;
}
