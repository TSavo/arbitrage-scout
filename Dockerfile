# Arbitrage Scout — runtime image with Playwright + Node 22 + tsx.
#
# Two stages:
#   1. deps  — install pnpm + node_modules (cached layer)
#   2. app   — copy source on top, ready to `pnpm tsx src/cli.ts scan`
#
# Playwright base ships with Chromium + system fonts pre-installed, so the
# scanner can launch headless browsers (HiBid, Mercari, Whatnot, K&L) without
# extra apt packages.
#
# pgvector is provided by the postgres service in compose, not here.

FROM mcr.microsoft.com/playwright:v1.59.1-jammy AS deps

WORKDIR /app

# Pin pnpm to the version locked in the workspace if present.
RUN corepack enable && corepack prepare pnpm@10.31.0 --activate

# Copy lockfile-only first so node_modules layer caches when source changes.
COPY package.json ./
COPY pnpm-lock.yaml* ./
COPY .npmrc* ./

RUN pnpm install --frozen-lockfile=false --prod=false

# ── App stage ──────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.59.1-jammy AS app

WORKDIR /app

ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:$PATH

# pnpm again for runtime tsx invocations.
RUN corepack enable && corepack prepare pnpm@10.31.0 --activate

# Bring node_modules from deps stage.
COPY --from=deps /app/node_modules ./node_modules

# Copy app source.
COPY . .

# Default command: run a single scan pass. docker-compose can override
# with bin/daily-scan.sh or any tsx command.
CMD ["pnpm", "tsx", "src/cli.ts", "scan"]
