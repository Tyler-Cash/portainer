FROM node:22-bookworm-slim AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
WORKDIR /app

# node:22-bookworm-slim only enables the "main" apt component by default;
# intel-media-va-driver-non-free lives in "non-free".
RUN sed -i 's/Components: main/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    intel-media-va-driver-non-free \
    vainfo \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

RUN mkdir -p /app/scratch

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Runs as root (not a dedicated non-root user, unlike a typical Next.js
# image) so it has unconditional access to /dev/dri/renderD128 regardless
# of the host's render-group GID — same trade-off zipline-transcoder makes
# for the same reason.
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV SCRATCH_DIR=/app/scratch

CMD ["node", "server.js"]
