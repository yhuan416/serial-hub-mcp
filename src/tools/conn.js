// 连接类串口工具：list_ports / open / close / write / read / transact / get_status /
// set_dtr_rts / send_break / receive / dump_to_file。
// 设计取向：串口收发数据如实获取，不做内容判读（正则/提示符匹配交给 agent）。
// handler 统一返回 {ok:true,response}，失败 throw 由 mcp-kit 转 isError。
import { z } from "zod";
import { SerialPort } from "serialport";
import { defineTool } from "../sdk/tool.js";
import { toBuffer, appendNewline } from "../encoding.js";
import * as profiles from "../profiles.js";
import { probeRemote } from "../remote/v1_connection.js";
import { loadRemotes, resolveRemote } from "../remotes.js";
import { allocDumpFile, publishDump } from "../dump_catalog.js";
import { listOpens, recordOpen } from "../open_log.js";

export const connId = z.string().min(1).describe("连接 ID（由 open 返回）");

const dataField = z
  .union([
    z.string().describe("将要发送/匹配的字符或 hex/base64 串"),
    z.object({
      hex: z.string().optional(),
      base64: z.string().optional(),
      text: z.string().optional(),
    }),
  ])
  .describe("字符串或 {hex}/{base64}/{text} 对象，encoding 决定解码方式");

const newlineField = z
  .enum(["none", "cr", "lf", "crlf"])
  .optional()
  .describe("发送时自动追加的换行（none 不加）");

/** 按 sn/vid/pid 从系统设备表定位串口路径。 */
async function resolvePortBySpec({ sn, vid, pid }) {
  const ports = await SerialPort.list();
  const match = ports.find((p) => {
    const snOk = !sn || p.serialNumber === sn;
    const vidOk = !vid || (p.vendorId || "").toLowerCase() === String(vid).toLowerCase();
    const pidOk = !pid || (p.productId || "").toLowerCase() === String(pid).toLowerCase();
    return snOk && vidOk && pidOk;
  });
  if (!match)
    throw new Error(
      `未找到匹配串口（sn=${sn || "-"} vid=${vid || "-"} pid=${pid || "-"}），先 list_ports 确认`,
    );
  return match.path;
}

function must(manager, id) {
  const conn = manager.get(id);
  if (!conn) throw new Error(`连接不存在: ${id}`);
  return conn;
}

function looksText(buf) {
  if (!buf || buf.length === 0) return true;
  const s = buf.toString("utf8");
  if (s.includes("\uFFFD")) return false;
  let ctrl = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) ctrl += 1;
  }
  return ctrl / Math.max(1, s.length) < 0.1;
}

/** include_hex=true 强制带 hex；缺省只在非文本数据时带，避免响应翻倍。 */
function applyHexPolicy(response, includeHex) {
  if (includeHex === true) return response;
  if (response && typeof response.text === "string") {
    const buf = Buffer.from(response.text, "utf8");
    if (looksText(buf)) delete response.hex;
  }
  return response;
}

function frameResult(r, includeHex) {
  const out = {
    connection_id: r.connection_id,
    bytes: r.data.length,
    text: r.data.toString("utf8"),
    start_offset: r.start_offset,
    end_offset: r.end_offset,
    next_offset: r.next_offset,
    matched: r.matched,
    timed_out: r.timed_out,
    stopped_reason: r.stopped_reason,
    gap: r.gap,
    gap_bytes: r.gap_bytes,
    gap_from_offset: r.gap_from_offset ?? null,
    gap_to_offset: r.gap_to_offset ?? null,
    ring_start_offset: r.ring_start_offset,
    ring_end_offset: r.ring_end_offset,
    has_more: r.has_more,
    error: r.error || null,
  };
  if (includeHex === true || !looksText(r.data)) out.hex = r.data.toString("hex");
  return out;
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), Math.max(1, ms));
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function normalizeRemotePort(p, remote) {
  return {
    id: p.id ?? null,
    path: p.path ?? null,
    kind: p.kind ?? "uart",
    manufacturer: p.manufacturer ?? null,
    serial_number: p.serial_number ?? p.serialNumber ?? null,
    vendor_id: p.vendor_id ?? p.vendorId ?? null,
    product_id: p.product_id ?? p.productId ?? null,
    pins: p.pins ?? null,
    open: p.open ?? null,
    baud_rate: p.baud_rate ?? null,
    last_error: p.last_error ?? null,
    caps: p.caps ?? null,
    source: "remote",
    remote: remote.name,
    endpoint: remote.endpoint,
  };
}

async function queryRemotePorts(remote) {
  const timeout = remote.timeout_ms ?? 15000;
  const info = await withTimeout(
    probeRemote({
      endpoint: remote.endpoint,
      token: remote.token,
      timeoutMs: timeout,
    }),
    timeout + 3000,
    `remote "${remote.name}" 连接`,
  );
  try {
    const list = Array.isArray(info && info.ports) ? info.ports : [];
    const ports = list.map((p) => normalizeRemotePort(p, remote));
    return {
      ok: true,
      source: "remote",
      name: remote.name,
      endpoint: remote.endpoint,
      count: ports.length,
      ports,
      caps: info?.caps ?? null,
      time: info?.time ?? null,
      remote: {
        fw_version: info?.fw_version ?? null,
        board: info?.board ?? null,
      },
    };
  } catch (err) {
    throw err;
  }
}

async function listLocalPorts() {
  let ports = [];
  let warning;
  try {
    ports = await SerialPort.list();
  } catch (err) {
    // 受限环境（容器无 udevadm/sysfs）时返回空列表而不是报错
    warning = `无法枚举串口（${(err && err.message) || err}）；返回空列表`;
  }
  return {
    ports: ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer ?? null,
      serialNumber: p.serialNumber ?? null,
      serial_number: p.serialNumber ?? null,
      pnpId: p.pnpId ?? null,
      locationId: p.locationId ?? null,
      vendorId: p.vendorId ?? null,
      vendor_id: p.vendorId ?? null,
      productId: p.productId ?? null,
      product_id: p.productId ?? null,
      source: "local",
    })),
    warning,
  };
}

export const connTools = (manager) => [
  defineTool({
    name: "list_ports",
    title: "列出串口",
    description:
      "枚举串口。默认枚举本机，并自动汇总所有已配置 remote 的端口列表（见 ~/.config/serial-hub-mcp/remotes.json）。" +
      "可指定 endpoint 单查某个远端，或 remote 只查某个已配置的远端；include_local/include_remote 可裁剪。" +
      "返回扁平 ports（每条带 source/remote）与按来源分组的 sources；远端失败只体现在 sources[i].error，不影响其它来源。",
    inputSchema: z.object({
      endpoint: z
        .string()
        .optional()
        .describe("只查某个远端地址（如 tcp://host:7000）；省略则汇总所有已配置 remote"),
      token: z.string().optional().describe("配合 endpoint 使用的 HELLO token"),
      remote: z.string().optional().describe("只查某个已配置的 remote（名字，见 remotes.json）"),
      include_remote: z
        .boolean()
        .optional()
        .describe("是否包含已配置的 remote，默认 true；false 则只列本机"),
      include_local: z.boolean().optional().describe("是否包含本机端口，默认 true"),
      timeout_ms: z.number().int().positive().optional().describe("单次远端查询超时，默认 15000"),
    }),
    handler: async (args) => {
      const cfg = loadRemotes();
      const timeout = args.timeout_ms ?? 15000;
      let targets = [];
      let explicit = false;
      if (args.endpoint) {
        explicit = true;
        const hit = cfg.remotes.find((r) => r.endpoint === args.endpoint);
        targets = [
          {
            name: hit?.name || args.endpoint,
            endpoint: args.endpoint,
            token: args.token ?? hit?.token,
            timeout_ms: timeout,
          },
        ];
      } else if (args.remote) {
        targets = [resolveRemote(args.remote)];
      } else if (args.include_remote !== false) {
        targets = cfg.remotes;
      }

      const localPromise = args.include_local === false ? Promise.resolve(null) : listLocalPorts();
      const remoteResults = await Promise.all(
        targets.map((t) =>
          queryRemotePorts(t).catch((err) => ({
            ok: false,
            source: "remote",
            name: t.name,
            endpoint: t.endpoint,
            error: (err && err.message) || String(err),
          })),
        ),
      );
      const local = await localPromise;

      // 无远端、只列本机：保持旧形状
      if (!explicit && targets.length === 0) {
        const response = { source: "local", ports: local ? local.ports : [] };
        if (local && local.warning) response.warning = local.warning;
        return { ok: true, response };
      }

      const sources = [];
      if (local) {
        sources.push({
          source: "local",
          ok: !local.warning,
          count: local.ports.length,
          ...(local.warning ? { warning: local.warning } : {}),
        });
      }
      sources.push(...remoteResults);

      const ports = [
        ...(local ? local.ports : []),
        ...remoteResults.flatMap((r) => (r.ok ? r.ports : [])),
      ];
      const warnings = [
        ...cfg.warnings,
        ...remoteResults.filter((r) => !r.ok).map((r) => `remote "${r.name}": ${r.error}`),
      ];

      // 显式 endpoint 单查：额外保留旧的顶层字段，便于兼容
      if (explicit) {
        const r = remoteResults[0];
        if (!r.ok) throw new Error(`远端不可用: ${r.error}`);
        return {
          ok: true,
          response: {
            source: "remote",
            endpoint: r.endpoint,
            ports: r.ports,
            caps: r.caps,
            time: r.time,
            remote: r.remote,
            sources,
          },
        };
      }

      const response = { ports, sources };
      if (cfg.file) response.remotes_file = cfg.file;
      if (cfg.fromEnv) response.remotes_source = "env";
      if (local && local.warning) response.warning = local.warning;
      if (warnings.length) response.warnings = warnings;
      return { ok: true, response };
    },
  }),

  defineTool({
    name: "open",
    title: "打开串口",
    description:
      "打开一个串口连接。定位端口三选一：port（路径）/ profile（命名参数）/ sn|vid|pid（按设备标识自动找）。" +
      "transport=remote 时用 endpoint + port_id（如 endpoint=tcp://192.168.4.67:7000, port_id=uart1），不要传 port/sn/vid/pid。" +
      "baud_rate 默认 115200；data_bits 默认 8；stop_bits 默认 1；parity 默认 none；flow_control 默认 none。" +
      "newline 设置发送默认追加的换行（write/transact 未显式指定时的默认）。" +
      "成功后返回 connection_id，后续 read/write/transact 用它。" +
      "同一路 UART 只有一个 writer。第二路要写时传 claim_writer:true。" +
      "可选 name 给这次打开起名。成功后按 endpoint+port_id+波特率去重记入 open_list。返回里的 token 为 ***。",
    inputSchema: z.object({
      transport: z
        .enum(["serial", "remote"])
        .optional()
        .describe(
          "链路类型：serial=本机串口（默认）；remote=ESP32 无线串口桥（token 鉴权，需 endpoint）",
        ),
      endpoint: z
        .string()
        .optional()
        .describe("远端地址（transport=remote 时必填），如 tcp://esp32s3-01:7000"),
      token: z
        .string()
        .optional()
        .describe("远端鉴权 token（transport=remote 必填；桥启动日志/配网 QR 可见）"),
      remote: z
        .string()
        .optional()
        .describe("已配置的 remote 名（remotes.json）；自动填充 endpoint/token，可被显式参数覆盖"),
      port_id: z.string().optional().describe("远端设备端口 ID（多端口设备用；缺省由设备选择）"),
      claim_writer: z
        .boolean()
        .optional()
        .describe("远端已有 writer 时抢走写权。默认 false，第二路只读"),
      port: z.string().optional().describe("串口路径，如 /dev/ttyUSB0、/dev/ttyACM0、COM3"),
      profile: z
        .string()
        .optional()
        .describe("已保存的 profile 名（profile_list 查看；显式参数覆盖 profile）"),
      sn: z.string().optional().describe("按序列号定位（list_ports.serialNumber）"),
      vid: z.string().optional().describe("按厂商 ID 定位（如 1a86、303a）"),
      pid: z.string().optional().describe("按产品 ID 定位（如 55d3、1001）"),
      baud_rate: z.number().int().optional().describe("波特率，默认 115200"),
      data_bits: z
        .union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)])
        .optional()
        .describe("数据位，默认 8"),
      stop_bits: z
        .union([z.literal(1), z.literal(2)])
        .optional()
        .describe("停止位，默认 1（Node serialport 仅支持 1/2）"),
      parity: z.enum(["none", "even", "odd"]).optional().describe("校验，默认 none"),
      flow_control: z
        .enum(["none", "rtscts", "dsrdtr", "xon", "xoff"])
        .optional()
        .describe("流控，默认 none"),
      rx_buffer_size: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("内部 RX 缓冲上限字节数，默认 4194304 (4 MiB)"),
      newline: newlineField,
      name: z.string().optional().describe("这次打开的名字，如「主控」。不传则保留上次名字"),
    }),
    handler: async (args) => {
      const merged = { ...args };
      const openName = merged.name;
      delete merged.name;

      // 1) 从 profile 取未显式给定的参数
      if (args.profile) {
        const pf = profiles.get(args.profile);
        if (!pf) throw new Error(`profile 不存在: ${args.profile}（profile_list 查看可用）`);
        for (const k of Object.keys(pf)) {
          if (k !== "note" && args[k] === undefined) merged[k] = pf[k];
        }
        delete merged.profile;
      }

      // 2) 命名 remote：填充 endpoint/token（显式参数优先）
      if (merged.remote) {
        if (merged.transport === "serial") {
          throw new Error("open: remote 仅用于 transport=remote，不能与 transport=serial 同时使用");
        }
        const r = resolveRemote(merged.remote);
        if (!merged.endpoint) merged.endpoint = r.endpoint;
        if (merged.token == null) merged.token = r.token;
        merged.transport = "remote";
        delete merged.remote;
      }

      // 3) 链路类型：remote 用 endpoint；serial 用 port/sn/vid/pid
      const transport = merged.transport ?? (merged.endpoint ? "remote" : "serial");
      if (transport === "remote") {
        if (!merged.endpoint) throw new Error("open: transport=remote 需要 endpoint");
        if (merged.port || merged.sn || merged.vid || merged.pid) {
          throw new Error(
            "open: transport=remote 不接受 port/sn/vid/pid。请用 endpoint + port_id，例如 " +
              "open({transport:'remote', endpoint:'tcp://192.168.4.67:7000', port_id:'uart1', baud_rate:1500000})",
          );
        }
      } else {
        if (merged.endpoint) {
          throw new Error("open: endpoint 仅用于 transport=remote（serial 用 port/sn/vid/pid）");
        }
        if (merged.token || merged.port_id) {
          throw new Error("open: token/port_id 仅用于 transport=remote");
        }
        if (!merged.port) {
          if (!merged.sn && !merged.vid && !merged.pid) {
            throw new Error("open: 需要 port（或 profile/sn/vid/pid）");
          }
          merged.port = await resolvePortBySpec({
            sn: merged.sn,
            vid: merged.vid,
            pid: merged.pid,
          });
        }
      }
      merged.transport = transport;
      delete merged.sn;
      delete merged.vid;
      delete merged.pid;

      const response = await manager.open(merged);
      recordOpen(response, openName);
      return { ok: true, response };
    },
  }),

  defineTool({
    name: "open_list",
    title: "已打开过的会话",
    description:
      "列出成功打开过的端口索引。同一 endpoint+port_id+波特率只留一行，重复打开只更新时间和次数。不存 token。",
    inputSchema: z.object({
      port: z.string().optional().describe("按 port_id 或本机串口路径精确过滤"),
      name: z.string().optional().describe("按名字子串过滤，不区分大小写"),
    }),
    handler: async (args) => ({ ok: true, response: listOpens(args) }),
  }),

  defineTool({
    name: "close",
    title: "关闭串口",
    description: "关闭一个之前打开的串口连接。",
    inputSchema: z.object({ connection_id: connId }),
    handler: async (args) => ({ ok: true, response: await manager.close(args.connection_id) }),
  }),

  defineTool({
    name: "write",
    title: "发送串口数据",
    description:
      "向串口发送数据（只发不收）。data 为字符串，encoding 决定解码方式：" +
      'utf8（默认，直接按文本）、hex（如 "AF 01"）、base64。成功后返回写入字节数。' +
      '如需"发完等回包"请用 transact。newline 未写时用 open 时的默认。' +
      "发一行命令建议 newline=crlf，避免把字面换行当命令。",
    inputSchema: z.object({
      connection_id: connId,
      data: dataField,
      encoding: z.enum(["utf8", "hex", "base64"]).optional().describe("data 的编码方式，默认 utf8"),
      newline: newlineField,
    }),
    handler: async (args) => {
      const conn = must(manager, args.connection_id);
      let buf = toBuffer(args.data, args.encoding || "utf8");
      const newline = args.newline ?? conn.config.newline ?? "none";
      buf = appendNewline(buf, newline);
      const bytes = await conn.write(buf);
      return { ok: true, response: { connection_id: conn.id, bytes_written: bytes, newline } };
    },
  }),

  defineTool({
    name: "read",
    title: "读取串口数据",
    description:
      "读取串口已到达的数据。默认立即返回所有未读字节（cat 语义）。" +
      "wait_ms>0 时等待新数据；min_bytes 指定等待的最少字节数。" +
      "match + match_encoding 指定匹配串：一旦缓冲里出现匹配即返回（含匹配部分）。" +
      "返回 text/hex/bytes 及 matched/timed_out。",
    inputSchema: z.object({
      connection_id: connId,
      match: z.string().optional().describe("匹配串：缓冲中出现即返回（含匹配到的那段）"),
      match_encoding: z
        .enum(["utf8", "hex", "base64"])
        .optional()
        .describe("match 的编码，默认 utf8"),
      min_bytes: z.number().int().positive().optional().describe("等待的最少字节数，默认 1"),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("若无数据则等待的毫秒数，默认 0 立即返回"),
      include_hex: z
        .boolean()
        .optional()
        .describe("保留 hex（默认 false；仅非文本数据自动带，二进制排查时打开）"),
    }),
    handler: async (args) => {
      const conn = must(manager, args.connection_id);
      const match = args.match ? toBuffer(args.match, args.match_encoding || "utf8") : undefined;
      const r = await conn.read({
        match,
        minBytes: args.min_bytes ?? 1,
        waitMs: args.wait_ms ?? 0,
      });
      return { ok: true, response: frameResult(r, args.include_hex) };
    },
  }),

  defineTool({
    name: "transact",
    title: "收发交互（写+读）",
    description:
      "写入数据后等待回包，在一步内完成，是 AT/Modbus/GRBL 等请求响应式交互的推荐入口。" +
      '写后只关心"写之后到达"的字节（忽略此前已缓冲的噪声）。' +
      "timeout_ms 限时等待；match + match_encoding 指定响应结束标志。返回 text/hex/bytes 及 matched/timed_out。" +
      "交互终端推荐 newline=crlf + match=提示符，避免把字面换行当命令。",
    inputSchema: z.object({
      connection_id: connId,
      data: dataField,
      encoding: z.enum(["utf8", "hex", "base64"]).optional().describe("data 的编码方式，默认 utf8"),
      newline: newlineField,
      match: z.string().optional().describe('响应结束匹配串，如 "\\n"、"OK"'),
      match_encoding: z
        .enum(["utf8", "hex", "base64"])
        .optional()
        .describe("match 的编码，默认 utf8"),
      timeout_ms: z.number().int().min(0).optional().describe("等待回包的最大毫秒数，默认 5000"),
      include_hex: z.boolean().optional().describe("保留 hex（默认 false；仅非文本数据自动带）"),
    }),
    handler: async (args) => {
      const conn = must(manager, args.connection_id);
      let buf = toBuffer(args.data, args.encoding || "utf8");
      const newline = args.newline ?? conn.config.newline ?? "none";
      buf = appendNewline(buf, newline);
      const match = args.match ? toBuffer(args.match, args.match_encoding || "utf8") : undefined;
      const r = await conn.transact(buf, { match, minBytes: 1, waitMs: args.timeout_ms ?? 5000 });
      const f = frameResult(r, args.include_hex);
      f.newline = newline;
      return { ok: true, response: f };
    },
  }),

  defineTool({
    name: "get_status",
    title: "连接状态",
    description:
      "查看指定连接（或多个连接）的打开状态、波特率、收发字节数、剩余未读字节。connection_id 省略则列出全部连接。返回里的 token 为 ***。",
    inputSchema: z.object({
      connection_id: connId.optional().describe("连接 ID；省略则返回全部连接状态"),
    }),
    handler: async (args) => {
      if (args.connection_id) {
        const conn = must(manager, args.connection_id);
        return { ok: true, response: { connections: [conn.status()] } };
      }
      return { ok: true, response: { connections: manager.list() } };
    },
  }),

  defineTool({
    name: "set_dtr_rts",
    title: "设置 DTR/RTS 控制线",
    description:
      "设置串口 DTR/RTS 调制解调控制线电平。未传的线保持不动。" +
      'pulse_ms>0 时先设为给定值、保持该时长后自动反转（一次完成"拉低→放高"之类的复位时序，如 Arduino 自动复位）。' +
      "需要多拍精确时序（如 ESP32 进下载模式）时，可分多次调用本工具逐拍设置。" +
      "返回最终 dtr/rts 电平。",
    inputSchema: z.object({
      connection_id: connId,
      dtr: z.boolean().optional().describe("DTR 电平，true=assert；省略则不动"),
      rts: z.boolean().optional().describe("RTS 电平，true=assert；省略则不动"),
      pulse_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("设置后保持的毫秒数，届时反转（复位时序）"),
    }),
    handler: async (args) => {
      const conn = must(manager, args.connection_id);
      const pulsed = args.pulse_ms != null && args.pulse_ms > 0;
      const level = pulsed
        ? await conn.setPulse({ dtr: args.dtr, rts: args.rts, pulseMs: args.pulse_ms })
        : await conn.setLine({ dtr: args.dtr, rts: args.rts });
      return {
        ok: true,
        response: { connection_id: conn.id, pulsed, dtr: level.dtr, rts: level.rts },
      };
    },
  }),

  defineTool({
    name: "send_break",
    title: "发送 BREAK 信号",
    description:
      "向串口发送 BREAK 信号并释放（保持 duration_ms 后释放）。常用于唤醒/复位只认 BREAK 的设备。duration_ms 默认 300。",
    inputSchema: z.object({
      connection_id: connId,
      duration_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("BREAK 保持时长（毫秒），默认 300"),
    }),
    handler: async (args) => {
      const conn = must(manager, args.connection_id);
      const duration_ms = args.duration_ms ?? 300;
      await conn.sendBreak(duration_ms);
      return { ok: true, response: { connection_id: conn.id, duration_ms } };
    },
  }),

  defineTool({
    name: "receive",
    title: "统一接收窗口（持续收流量直到结束）",
    description:
      "持续消费全部到达流量，直到命中 match(字节)、达到 max_bytes、静默 idle_timeout_ms、或 budget_ms 耗尽。" +
      "结束时不丢弃流量——期间所有字节如实带回，由 matched/stopped_reason 说明命中情况；内容判读交给 agent。" +
      "start=cursor 从当前游标起；start=flush 先清缓冲（干净窗口）再开始；可选 reset 复位（配合 start=flush 抓启动日志）。" +
      "抓 boot 示例：receive({start:'flush', reset:'dtr', budget_ms:15000})。",
    inputSchema: z.object({
      connection_id: connId,
      start: z
        .enum(["cursor", "flush"])
        .optional()
        .describe("cursor=从当前游标（默认）；flush=先清缓冲再开始"),
      reset: z
        .enum(["none", "dtr", "rts"])
        .optional()
        .describe("（start=flush 配合）复位方式，默认 none"),
      reset_pulse_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("复位脉冲保持毫秒数，默认 100"),
      match: z.string().optional().describe('出现即停的匹配串（字节级），如 "login:"'),
      match_encoding: z
        .enum(["utf8", "hex", "base64"])
        .optional()
        .describe("match 的编码，默认 utf8"),
      idle_timeout_ms: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("静默即停阈值（毫秒），默认 300"),
      budget_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("整次观察预算（毫秒），默认 10000"),
      max_bytes: z.number().int().positive().optional().describe("返回字节上限"),
      include_hex: z.boolean().optional().describe("保留 hex（默认 false；仅非文本数据自动带）"),
    }),
    handler: async (args) => {
      const conn = must(manager, args.connection_id);
      const match = args.match ? toBuffer(args.match, args.match_encoding || "utf8") : undefined;
      const resp = await conn.receive({
        start: args.start ?? "cursor",
        reset: args.reset ?? "none",
        resetPulseMs: args.reset_pulse_ms ?? 100,
        match,
        idleTimeoutMs: args.idle_timeout_ms ?? 300,
        budgetMs: args.budget_ms ?? 10000,
        maxBytes: args.max_bytes,
      });
      return { ok: true, response: applyHexPolicy(resp, args.include_hex) };
    },
  }),

  defineTool({
    name: "dump_to_file",
    title: "导出已缓存的一段",
    description:
      "把 host 已有缓存导出成文件，立刻返回 file_id / sha256 / download_path。不读新数据，不移动 read 游标。" +
      "默认按行索引（seq/时间）。二进制没有换行时传 offset_from/offset_to 导出原始字节。" +
      "接着看新数据用 read 或 receive。下载：GET http://<hub>:8788/dumps/<file_id>，Bearer 与 /mcp 相同。",
    inputSchema: z.object({
      connection_id: connId,
      dir: z.enum(["rx", "tx"]).optional().describe("行方向，默认两边"),
      seq_from: z.number().int().optional().describe("起始 seq（含）"),
      seq_to: z.number().int().optional().describe("结束 seq（含）"),
      time_from: z.number().int().optional().describe("起始时间，epoch ms（含）"),
      time_to: z.number().int().optional().describe("结束时间，epoch ms（含）"),
      offset_from: z.number().int().optional().describe("原始字节起始偏移。给出后按字节环导出，不用 seq"),
      offset_to: z.number().int().optional().describe("原始字节结束偏移，不含"),
    }),
    handler: async (args) => {
      const conn = must(manager, args.connection_id);
      const allocated = allocDumpFile("dump");
      const raw = await conn.dumpToFile({
        file: allocated.file,
        dir: args.dir,
        seq_from: args.seq_from,
        seq_to: args.seq_to,
        time_from: args.time_from,
        time_to: args.time_to,
        offset_from: args.offset_from,
        offset_to: args.offset_to,
      });
      return { ok: true, response: publishDump(raw, allocated.file_id, allocated.file) };
    },
  }),
];
