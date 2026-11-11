// profile 工具：profile_list / profile_save / profile_delete。
import { z } from "zod";
import { defineTool } from "../sdk/tool.js";
import * as profiles from "../profiles.js";

const ALLOWED = [
  "transport",
  "endpoint",
  "token",
  "port_id",
  "port",
  "baud_rate",
  "data_bits",
  "stop_bits",
  "parity",
  "flow_control",
  "rx_buffer_size",
  "newline",
  "prompt",
  "regex",
  "note",
];

export function profileTools() {
  return [
    defineTool({
      name: "profile_list",
      title: "列出连接 profile",
      description:
        "列出已保存的串口连接 profile（port/波特率/换行/prompt 等参数），open({profile:name}) 一条复用。",
      inputSchema: z.object({}),
      handler: async () => ({ ok: true, response: { profiles: profiles.list() } }),
    }),
    defineTool({
      name: "profile_save",
      title: "保存连接 profile",
      description:
        "把常见连接参数存为命名 profile，供 open({profile}) 一条复用。字段与 open 一致：transport/endpoint/token/port_id/port/baud_rate/data_bits/stop_bits/parity/flow_control/rx_buffer_size/newline/prompt/regex/note。",
      inputSchema: z.object({
        name: z.string().min(1).describe("profile 名，如 quarkpi、uart0"),
        transport: z.enum(["serial", "remote"]).optional().describe("链路类型，默认 serial"),
        endpoint: z.string().optional().describe("远端地址（transport=remote 时用）"),
        token: z.string().optional().describe("远端鉴权 token（可选）"),
        port_id: z.string().optional().describe("远端设备端口 ID（可选）"),
        port: z.string().optional().describe("串口路径（可省略，open 时另行指定）"),
        baud_rate: z.number().int().positive().optional().describe("波特率，默认 115200"),
        data_bits: z.number().int().optional(),
        stop_bits: z.number().int().optional(),
        parity: z.enum(["none", "even", "odd"]).optional(),
        flow_control: z.enum(["none", "rtscts", "dsrdtr", "xon", "xoff"]).optional(),
        rx_buffer_size: z.number().int().positive().optional(),
        newline: z
          .enum(["none", "cr", "lf", "crlf"])
          .optional()
          .describe("发送默认追加的换行，默认 none"),
        prompt: z
          .string()
          .optional()
          .describe("shell 提示符正则，receive(prompt:true) 用它作结束条件"),
        regex: z.string().optional().describe("默认结束正则"),
        note: z.string().optional().describe("备注"),
      }),
      handler: async (args) => {
        const { name, ...cfg } = args;
        const cleaned = {};
        for (const k of ALLOWED) if (cfg[k] !== undefined) cleaned[k] = cfg[k];
        return { ok: true, response: { saved: profiles.put(name, cleaned) } };
      },
    }),
    defineTool({
      name: "profile_delete",
      title: "删除连接 profile",
      description: "删除指定命名 profile。",
      inputSchema: z.object({ name: z.string().min(1).describe("profile 名") }),
      handler: async (args) => ({
        ok: true,
        response: { removed: profiles.remove(args.name), name: args.name },
      }),
    }),
  ];
}
