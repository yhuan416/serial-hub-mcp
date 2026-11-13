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
        "远端 order=desc 默认从最新开始；contains/regex 会分页扫描 RAM 窗口（有上限），time_from/time_to 暂不支持（设备无 NTP）。" +
        "返回 entries（含 count/truncated）与 earliest_seq；远端另给 ram_earliest_seq/sd_earliest_seq，二者含义不同。",
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
        segment: z
          .string()
          .optional()
          .describe("SD segment ID；省略导出当前活动 segment（log_stats.segments 查看）"),
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
      name: "log_sync",
      title: "增量归档远端日志",
      description:
        "把远端 SD 日志增量导出到 host 目录，按 segment/方向维护 state.json 水位，只导出自上次水位之后的新 seq。" +
        "默认导出所有 segment 的 rx+tx；这是长期采集用的 collector，不是实时 dump_to_file。" +
        "可重复调用；同一 segment/dir 会追加到 <out_dir>/<segment>-<dir>.log。",
      inputSchema: z.object({
        connection_id: connId.describe("远端连接 ID（open 返回）"),
        dir: z.enum(["rx", "tx"]).optional().describe("方向；省略则 rx+tx"),
        segment: z.string().optional().describe("只同步指定 segment；省略全部"),
        out_dir: z
          .string()
          .optional()
          .describe("归档目录；缺省 ~/.cache/serial-hub-mcp/remote-sync/<endpoint>"),
        max_pages: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("每轮 LOG_EXPORT 页数上限（默认 10000）"),
        max_bytes: z.number().int().positive().optional().describe("每页字节上限（默认 32768）"),
      }),
      handler: async (args) => ({ ok: true, response: await requireStore().sync(args) }),
    }),

    defineTool({
      name: "event_query",
      title: "查询设备控制面事件",
      description:
        "查询远端设备的控制面事件（与串口数据日志分离）：SD 挂载/格式化/重挂载、" +
        "SD 写/fsync 失败、ring 丢字节等。设备侧事件是 RAM 环形队列（默认 64 条），" +
        "同时会打印到串口控制台。仅远端连接支持。",
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
        "清空指定连接的日志：本地为内存 + 已落盘文件；远端省略 segment 会清空设备所有 segment 和 RAM，指定 segment 只清该段。清空后不可恢复。" +
        "省略 connection_id 会清空本地 + 所有远端，必须显式传 confirm=true。",
      inputSchema: z.object({
        connection_id: connId.optional().describe("连接 ID；省略则清空本地与所有远端"),
        segment: z.string().optional().describe("远端 SD segment ID；省略清空设备当前活动 segment"),
        confirm: z.boolean().optional().describe("全量清空（不传 connection_id）时必须为 true"),
      }),
      handler: async (args) => ({
        ok: true,
        response: await requireStore().clear(args.connection_id, args),
      }),
    }),
  ];
};
