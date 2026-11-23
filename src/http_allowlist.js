// HTTP Host/Origin allowlist。
//
// 绑定 loopback 且端口已知时，默认只接受本机 Host/Origin，缓解 DNS rebinding。
// 非 loopback 或端口为 0（临时端口）时不做默认限制；可以用环境变量显式配置。

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function splitList(raw) {
  if (typeof raw !== "string") return undefined;
  const list = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length ? [...new Set(list)] : undefined;
}

export function buildHttpAllowlist({ host, port, env = process.env } = {}) {
  const explicitHosts = splitList(env.SERIAL_HUB_MCP_HTTP_ALLOWED_HOSTS);
  const explicitOrigins = splitList(env.SERIAL_HUB_MCP_HTTP_ALLOWED_ORIGINS);

  const numericPort = Number(port);
  const canDefault = LOOPBACK_HOSTS.has(host) && Number.isFinite(numericPort) && numericPort > 0;

  const defaultHosts = canDefault
    ? [
        `${host}:${numericPort}`,
        `localhost:${numericPort}`,
        `127.0.0.1:${numericPort}`,
        `[::1]:${numericPort}`,
      ]
    : undefined;
  const defaultOrigins = canDefault
    ? [
        `http://${host}:${numericPort}`,
        `http://localhost:${numericPort}`,
        `http://127.0.0.1:${numericPort}`,
        `http://[::1]:${numericPort}`,
      ]
    : undefined;

  return {
    allowedHosts: explicitHosts ?? (defaultHosts ? [...new Set(defaultHosts)] : undefined),
    allowedOrigins: explicitOrigins ?? (defaultOrigins ? [...new Set(defaultOrigins)] : undefined),
  };
}
