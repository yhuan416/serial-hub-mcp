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
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      title: "检索串口日志",
      description:
        "检索 host 已切开的串口日志。日志按行切分（\\n / \\r\\n），每条含 seq、epoch 时间戳 ts、方向 dir(rx/tx)、内容 line。" +
        "支持按连接、方向、seq 范围、时间范围、子串和正则过滤。本地和远端都只查 host 缓存，不向设备要历史。" +
        "host 还没切出整行的尾巴查不到。返回 entries（含 count/truncated）与 earliest_seq。" +
        "不传 time_from/seq_from 会回到缓存里还留着的最早一行（默认最多 7 天），不能当成这次才出现的日志。只要开始观察之后的，先 time_now 取 epoch_ms 再传 time_from。",
      inputSchema: z.object({
        connection_id: connId.optional().describe("连接 ID；省略则全查"),
        dir: z.enum(["rx", "tx"]).optional().describe("方向过滤"),
        seq_from: z.number().int().optional().describe("索引下界（含）"),
        seq_to: z.number().int().optional().describe("索引上界（含）"),
        time_from: z
          .number()
          .int()
          .optional()
          .describe("时间下界（epoch ms，含）。不传则含更早的缓存行，可能早于本次观察"),
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
      name: "log_stats",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      title: "清空串口日志",
      description:
        "清空 host 上已切开的日志。远端只清 host 缓存，不清设备。清空后不可恢复。" +
        "省略 connection_id 会清空本进程全部 host 日志，必须显式传 confirm=true。",
      inputSchema: z.object({
        connection_id: connId.optional().describe("连接 ID；省略则清空本地与所有远端"),
        confirm: z.boolean().optional().describe("全量清空（不传 connection_id）时必须为 true"),
      }),
      handler: async (args) => ({
        ok: true,
        response: await requireStore().clear(args.connection_id, args),
      }),
    }),
  ];
};
