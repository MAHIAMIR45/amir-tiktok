# TikTok Auto Post Bot — Render deployment (Docker runtime)
# Builder: bun (fast install + build) | Runner: node:22-slim + chromium (signer ke liye)
#
# NOTE: server ko bun par NAHI chalate (bun + undici v7 ka webidl.util.markAsUncloneable
# issue hai) — runner node:22 use karta hai jo undici v7 poora support karta hai.

# ---------------- builder ----------------
FROM oven/bun:1 AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Schema-ready SQLite DB banao (tables included) — runner me copy hogi taake fresh
# container par bhi bot turant kaam kare (empty DB par queries fail hoti hain).
RUN mkdir -p prisma-data \
  && DATABASE_URL=file:/app/prisma-data/bot.db bunx prisma db push --skip-generate --accept-data-loss

RUN bunx prisma generate
RUN bun run build

# ---------------- runner ----------------
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV DATABASE_URL=file:/app/data/bot.db
ENV TT_PROXY_MODE=direct

# Chromium (signer.ts /usr/bin/chromium dhoondta hai) + CA certs
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium

# Schema-ready database (tables included)
RUN mkdir -p /app/data
COPY --from=builder /app/prisma-data/bot.db /app/data/bot.db

# Next.js standalone output (build script static + public standalone ke andar copy karta hai)
COPY --from=builder /app/.next/standalone ./
# Belt & suspenders: signer ke JS assets (tracing inhe miss kar sakta hai)
COPY --from=builder /app/src/lib/tiktok/signer_js ./src/lib/tiktok/signer_js

EXPOSE 3000
CMD ["node", "server.js"]
