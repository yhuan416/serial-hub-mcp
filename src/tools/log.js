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
        "检索串口日志条目。日志按行切分（\\n / \\r\\n），每条含全局 seq 索引、epoch 时间戳 ts、方向 dir(rx/tx)、内容 line/hex/bytes。" +
        "支持按连接、方向、索引范围(seq_from/seq_to)、时间范围(time_from/time_to)、内容子串(contains)、正则(regex)过滤。" +
        "本地连接查 host LogStore（内存+JSONL 分片）；远端连接代理设备 LOG_QUERY（RAM 窗口，历史用 log_export）。" +
        "返回 entries（含 count/truncated）与 earliest_seq/retention（earliest_seq 之后的历史才完整，淘汰过的更早部分不可回溯）。",
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
        cursor: z.string().optional().describe("分页游标（远端 LOG_QUERY 的 next_cursor）"),
        order: z.enum(["asc", "desc"]).optional().describe("排序，默认 asc（旧→新）"),
      }),
      handler: async (args) => ({ ok: true, response: await requireStore().query(args) }),
    }),

    defineTool({
      name: "log_export",
      title: "导出远端设备权威日志",
      description:
        "把远端连接（transport=remote）的设备 SD 权威日志按 seq/方向分页导出到 host 文件。" +
        "和 dump_to_file 的区别：dump_to_file 是实时抓 RX；log_export 是事后从设备 SD 取历史。" +
        "需要设备 has_sd=true 且支持 LOG_EXPORT；本地连接请用 dump_to_file。" +
        "默认写入 $SERIAL_HUB_MCP_DUMPS_DIR（~/.cache/serial-hub-mcp/dumps）。" +
        "设备当前无 NTP，time_from/time_to 会被忽略（设备 ts 是 uptime tick）。",
      inputSchema: z.object({
        connection_id: connId.describe("远端连接 ID（open 返回）"),
        dir: z.enum(["rx", "tx"]).optional().describe("方向，默认 rx"),
        seq_from: z.number().int().optional().describe("起始 seq（含）"),
        seq_to: z.number().int().optional().describe("结束 seq（含）"),
        time_from: z.number().int().optional().describe("（暂忽略，设备无 NTP）"),
        time_to: z.number().int().optional().describe("（暂忽略，设备无 NTP）"),
        path: z.string().optional().describe("输出文件路径（优先于 out_dir）"),
        out_dir: z.string().optional().describe("输出目录（path 未给时用）"),
        max_bytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("每次 LOG_EXPORT 的字节上限，默认 32768"),
      }),
      handler: async (args) => ({ ok: true, response: await requireStore().export(args) }),
    }),

    defineTool({
      name: "log_stats",
      title: "串口日志统计",
      description:
        "查看日志存储统计：各连接的日志总条数、内存/磁盘分布、分区/淘汰信息、时间范围、目录路径；省略 connection_id 则给出全局汇总。",
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
      description: "清空指定连接（或全部）的日志：内存 + 已落盘文件。清空后不可恢复，谨慎使用。",
      inputSchema: z.object({
        connection_id: connId.optional().describe("连接 ID；省略则清空全部日志"),
      }),
      handler: async (args) => ({
        ok: true,
        response: await requireStore().clear(args.connection_id),
      }),
    }),
  ];
};
