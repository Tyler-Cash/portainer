FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    intel-media-va-driver-non-free \
    vainfo \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY watcher.js ./

CMD ["node", "watcher.js"]
