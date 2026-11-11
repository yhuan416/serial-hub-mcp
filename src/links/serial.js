// 本地串口链路：包装 serialport 的 SerialPort，产出 Connection 所需的 port 鸭子类型。
// 这是唯一直接依赖 serialport 的地方（tools 侧仅 list_ports 另用 SerialPort.list）。

import { SerialPort } from "serialport";

export const DEFAULT_BAUD = 115200;

// flow_control 名称 -> serialport 选项
export const FLOW_MAP = {
  none: {},
  rtscts: { rtscts: true },
  dsrdtr: { dsrdtr: true },
  xon: { xon: true },
  xoff: { xoff: true },
};

export const TRANSPORTS = ["serial", "remote"];

/**
 * 构建未打开的本地串口。
 * @param {{port:string, baud_rate?:number, data_bits?:number, stop_bits?:number,
 *          parity?:string, flow_control?:string}} cfg
 * @returns {import("serialport").SerialPort}
 */
export function createSerialLink(cfg) {
  return new SerialPort({
    path: cfg.port,
    baudRate: cfg.baud_rate ?? DEFAULT_BAUD,
    dataBits: cfg.data_bits ?? 8,
    stopBits: cfg.stop_bits ?? 1,
    parity: cfg.parity ?? "none",
    ...FLOW_MAP[cfg.flow_control ?? "none"],
    autoOpen: false,
  });
}
