# serial-hub-server (x86/Linux) container image
#
# docker build -f docker/serial-hub-server.Dockerfile -t serial-hub-server:latest .
# docker run --rm -p 7000:7000 -v shub-data:/data -v /dev:/dev -v /run/udev:/run/udev:ro \
#   --device-cgroup-rule 'c 166:* rmw' --device-cgroup-rule 'c 188:* rmw' --group-add 20 \
#   -e SERIAL_HUB_SERVER_TOKEN=... \
#   serial-hub-server:latest

FROM node:24-trixie-slim

ENV NODE_ENV=production \
    SERIAL_HUB_SERVER_LISTEN=0.0.0.0:7000 \
    SERIAL_HUB_SERVER_DATA_DIR=/data \
    SERIAL_HUB_SERVER_PORTS=/dev/ttyUSB,/dev/ttyACM,/dev/serial/

WORKDIR /app

# serialport 的 SerialPort.list() 依赖 udevadm / libudev
RUN apt-get update \
    && apt-get install -y --no-install-recommends udev libudev1 \
    && rm -rf /var/lib/apt/lists/*

# 只装运行依赖（serialport 走预编译包；缺预编译时需 python3/make/g++）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || (apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y python3 make g++ && apt-get autoremove -y)

COPY src ./src

RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 7000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const n=require('net');const s=n.connect(7000,'127.0.0.1',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))"

ENTRYPOINT ["node", "src/hub-server/index.js"]