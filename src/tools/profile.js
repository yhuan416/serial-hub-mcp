// profile 工具：profile_list / profile_save / profile_delete。
import { z } from "zod";
import { defineTool } from "../sdk/tool.js";
import * as profiles from "../profiles.js";

function maskToken(p) {
  if (!p || !p.token) return p;
  return { ...p, token: "***" };
}

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
  "note",
  "v1_window_bytes",
  "v1_ack_interval_bytes",
  "v1_lease_ms",
  "v1_resume",
  "v1_reconnect",
  "v1_reconnect_base_ms",
  "claim_writer",
];

export function profileTools() {
  return [
    defineTool({
      name: "profile_list",
      title: "列出连接 profile",
      description:
        "列出已保存的串口连接 profile（端口、波特率、换行）。token 不回明文。",
      inputSchema: z.object({}),
      handler: async () => ({
        ok: true,
        response: {
          profiles: profiles.list().map(maskToken),
        },
      }),
    }),
    defineTool({
      name: "profile_save",
      title: "保存连接 profile",
      description:
        "把常见连接参数存为命名 profile，供 open({profile}) 一条复用。返回里的 token 为 ***，文件里仍是原值。",
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
        note: z.string().optional().describe("备注"),
        claim_writer: z.boolean().optional().describe("打开时抢占写权"),
      }),
      handler: async (args) => {
        const { name, ...cfg } = args;
        const cleaned = {};
        for (const k of ALLOWED) if (cfg[k] !== undefined) cleaned[k] = cfg[k];
        return { ok: true, response: { saved: maskToken(profiles.put(name, cleaned)) } };
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
