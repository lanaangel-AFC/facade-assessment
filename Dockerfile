# Stage 1: Build
FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Production
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ poppler-utils imagemagick && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm rebuild better-sqlite3

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/node_modules/.package-lock.json* ./

# DATA_DIR is where the SQLite DB and uploads are stored.
# On Railway, mount a persistent volume at /data.
ENV DATA_DIR=/data
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Start the app — the server creates the DB on first run
CMD ["node", "dist/index.cjs"]
