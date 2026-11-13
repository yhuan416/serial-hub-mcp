# serial-hub-mcp HTTP 中心。不挂载串口。
# 本机端口由旁边的 serial-hub-server 暴露，MCP 只通过 TCP 访问各个 hub。
#
# docker build -f docker/serial-hub-mcp.Dockerfile -t serial-hub-mcp:latest .

FROM node:24-trixie-slim

ENV NODE_ENV=production \
    SERIAL_HUB_MCP_HTTP=1 \
    SERIAL_HUB_MCP_HTTP_HOST=0.0.0.0 \
    SERIAL_HUB_MCP_HTTP_PORT=8787 \
    XDG_CONFIG_HOME=/config \
    XDG_CACHE_HOME=/data \
    SERIAL_HUB_MCP_REMOTES_FILE=/config/remotes.json \
    SERIAL_HUB_MCP_LOGS_DIR=/data/logs \
    SERIAL_HUB_MCP_DUMPS_DIR=/data/dumps \
    SERIAL_HUB_MCP_SYNC_DIR=/data/remote-sync \
    SERIAL_HUB_MCP_V1_CACHE_DIR=/data/v1-cache \
    SERIAL_HUB_MCP_V1_STATE_FILE=/data/v1-cursors.json \
    SERIAL_HUB_MCP_PROFILES_DIR=/config

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev || (apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y python3 make g++ && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*)

COPY src ./src
COPY CHANGELOG.md ./CHANGELOG.md

RUN mkdir -p /data/logs /data/dumps /data/remote-sync /data/v1-cache /config \
    && chown -R node:node /data /config
USER node

EXPOSE 8787
VOLUME ["/data", "/config"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "src/server.js"]
