// 统一结果契约与错误映射。
//
// 约定：
//   - 业务成功:  { ok: true, response: <数据> }
//   - 业务失败:  { ok: false, error: { message } }
//   - MCP 层:    一律 packResult() 输出；业务失败经 content[].isError 表达，
//                不把业务错误提升为 JSON-RPC 层错误。

export function packResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: Boolean(payload && payload.ok === false),
  };
}

export function normalizeError(err) {
  return {
    ok: false,
    error: { message: err && err.message ? err.message : String(err) },
  };
}
