FROM node:22-bookworm-slim

# node:22-bookworm-slim only enables the "main" apt component by default;
# intel-media-va-driver-non-free lives in "non-free".
RUN sed -i 's/Components: main/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    intel-media-va-driver-non-free \
    vainfo \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY watcher.js ./

CMD ["node", "watcher.js"]
