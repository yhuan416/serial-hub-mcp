// 日志类串口工具：log_query / log_stats / log_clear。绑定 LogStore。
import { z } from "zod";
import { defineTool } from "../sdk/tool.js";
import { connId } from "./conn.js";

export const logTools = (logStore) => {
  const requireStore = () => {
    if (!logStore) throw new Error("日志功能未启用");
    return logStore;
  };
  return [
    defineTool({
      name: "log_query",
      title: "检索串口日志",
      description:
        "检索 host 已切开的串口日志。日志按行切分（\\n / \\r\\n），每条含 seq、epoch 时间戳 ts、方向 dir(rx/tx)、内容 line。" +
        "支持按连接、方向、seq 范围、时间范围、子串和正则过滤。本地和远端都只查 host 缓存，不向设备要历史。" +
        "host 还没切出整行的尾巴查不到。返回 entries（含 count/truncated）与 earliest_seq。",
      inputSchema: z.object({
        connection_id: connId.optional().describe("连接 ID；省略则全查"),
        dir: z.enum(["rx", "tx"]).optional().describe("方向过滤"),
        seq_from: z.number().int().optional().describe("索引下界（含）"),
        seq_to: z.number().int().optional().describe("索引上界（含）"),
        time_from: z.number().int().optional().describe("时间下界（epoch ms，含）"),
        time_to: z.number().int().optional().describe("时间上界（epoch ms，含）"),
        contains: z.string().optional().describe("内容子串匹配（区分大小写，作用于 line）"),
        regex: z.string().optional().describe("正则匹配（作用于 line）"),
        limit: z.number().int().positive().optional().describe("返回条数上限，默认 100"),
        cursor: z.string().optional().describe("分页游标，取上一页的 next_cursor"),
        order: z.enum(["asc", "desc"]).optional().describe("排序，默认 asc（旧→新）"),
        include_hex: z
          .boolean()
          .optional()
          .describe("保留每条 hex（默认 false，显著减小响应；二进制协议排查时打开）"),
      }),
      handler: async (args) => {
        const r = await requireStore().query(args);
        if (!args.include_hex && Array.isArray(r.entries)) {
          r.entries = r.entries.map(({ hex: _hex, ...rest }) => rest);
        }
        return { ok: true, response: r };
      },
    }),

    defineTool({
      name: "log_export",
      title: "导出 host 日志",
      description:
        "把 host 已切开的日志按方向和 seq 导出到文件。设备不是日志库，不会向设备要历史。" +
        "和 dump_to_file 的区别：dump_to_file 是实时抓还没切行的 RX；log_export 导出已经切开的行。" +
        "本地连接没有这个导出接口时用 log_query。默认写入 $SERIAL_HUB_MCP_DUMPS_DIR。",
      inputSchema: z.object({
        connection_id: connId.describe("远端连接 ID（open 返回）"),
        dir: z.enum(["rx", "tx"]).optional().describe("方向，默认 rx"),
        seq_from: z.number().int().optional().describe("起始 seq（含）"),
        seq_to: z.number().int().optional().describe("结束 seq（含）"),
        time_from: z.number().int().optional().describe("时间下界（epoch ms）；当前导出按 seq，不按时间裁剪"),
        time_to: z.number().int().optional().describe("时间上界（epoch ms）；当前导出按 seq，不按时间裁剪"),
        segment: z.string().optional().describe("忽略。当前链路没有设备 SD 段"),
        path: z.string().optional().describe("输出文件路径（优先于 out_dir）"),
        out_dir: z.string().optional().describe("输出目录（path 未给时用）"),
        max_bytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("忽略。导出的是 host 已切开的行，不按设备页大小分页"),
      }),
      handler: async (args) => ({ ok: true, response: await requireStore().export(args) }),
    }),

    defineTool({
      name: "log_sync",
      title: "增量归档 host 日志",
      description:
        "把 host 已切开的日志按方向增量追加到目录。水位写在该目录的 state.json，只导出上次之后的新 seq。" +
        "设备不是日志库。可重复调用；同一方向追加到 <out_dir>/<dir>.log。不是实时 dump_to_file。",
      inputSchema: z.object({
        connection_id: connId.describe("远端连接 ID（open 返回）"),
        dir: z.enum(["rx", "tx"]).optional().describe("方向；省略则 rx+tx"),
        segment: z.string().optional().describe("忽略。当前链路没有设备 SD 段"),
        out_dir: z
          .string()
          .optional()
          .describe("归档目录；缺省 ~/.cache/serial-hub-mcp/remote-sync/<endpoint>"),
        max_pages: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("忽略。同步的是 host 缓存，不向设备翻页"),
        max_bytes: z.number().int().positive().optional().describe("忽略。同步的是 host 已切开的行"),
      }),
      handler: async (args) => ({ ok: true, response: await requireStore().sync(args) }),
    }),

    defineTool({
      name: "event_query",
      title: "查询控制面事件",
      description:
        "当前链路没有设备事件日志。调用返回 supported:false，不要把它当成没有故障。" +
        "串口数据用 log_query；链路是否断开看 get_status。",
      inputSchema: z.object({
        connection_id: connId.describe("远端连接 ID（open 返回）"),
        seq_from: z.number().int().optional().describe("起始事件 seq（含）"),
        limit: z.number().int().positive().max(256).optional().describe("返回条数上限，默认 100"),
        level: z.enum(["info", "warn", "error"]).optional().describe("级别过滤"),
      }),
      handler: async (args) => ({
        ok: true,
        response: await requireStore().events(args.connection_id, args),
      }),
    }),

    defineTool({
      name: "log_stats",
      title: "串口日志统计",
      description:
        "查看日志存储统计：各连接的日志总条数、内存/磁盘分布、分区/淘汰信息、时间范围、目录路径；省略 connection_id 时聚合本地与所有远端连接。",
      inputSchema: z.object({
        connection_id: connId.optional().describe("连接 ID；省略则全查"),
      }),
      handler: async (args) => ({
        ok: true,
        response: await requireStore().stats(args.connection_id),
      }),
    }),

    defineTool({
      name: "log_clear",
      title: "清空串口日志",
      description:
        "清空 host 上已切开的日志。远端只清 host 缓存，不清设备。清空后不可恢复。" +
        "省略 connection_id 会清空本进程全部 host 日志，必须显式传 confirm=true。",
      inputSchema: z.object({
        connection_id: connId.optional().describe("连接 ID；省略则清空本地与所有远端"),
        segment: z.string().optional().describe("忽略。当前链路没有设备 SD 段"),
        confirm: z.boolean().optional().describe("全量清空（不传 connection_id）时必须为 true"),
      }),
      handler: async (args) => ({
        ok: true,
        response: await requireStore().clear(args.connection_id, args),
      }),
    }),
  ];
};
