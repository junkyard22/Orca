# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

# Native addon deps (better-sqlite3 needs python + make + g++)
RUN apk add --no-cache python3 make g++

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/benson-core/package.json   packages/benson-core/
COPY packages/dewey-core/package.json    packages/dewey-core/
COPY packages/ext-docs/package.json      packages/ext-docs/
COPY packages/ext-github/package.json    packages/ext-github/
COPY packages/ext-web/package.json       packages/ext-web/
COPY packages/maestro-core/package.json  packages/maestro-core/
COPY packages/miranda-core/package.json  packages/miranda-core/
COPY packages/orca-core/package.json     packages/orca-core/
COPY packages/pappy-core/package.json    packages/pappy-core/
COPY packages/workbench-core/package.json packages/workbench-core/
COPY apps/runner/package.json            apps/runner/

RUN pnpm install --frozen-lockfile

# Copy source and build
COPY packages/ packages/
COPY apps/runner/ apps/runner/

RUN pnpm --filter './packages/**' build
RUN pnpm --filter @clawde/runner build


# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN apk add --no-cache libstdc++

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/benson-core/package.json   packages/benson-core/
COPY packages/dewey-core/package.json    packages/dewey-core/
COPY packages/ext-docs/package.json      packages/ext-docs/
COPY packages/ext-github/package.json    packages/ext-github/
COPY packages/ext-web/package.json       packages/ext-web/
COPY packages/maestro-core/package.json  packages/maestro-core/
COPY packages/miranda-core/package.json  packages/miranda-core/
COPY packages/orca-core/package.json     packages/orca-core/
COPY packages/pappy-core/package.json    packages/pappy-core/
COPY packages/workbench-core/package.json packages/workbench-core/
COPY apps/runner/package.json            apps/runner/

# Production deps only (rebuilds native addons against runtime Node)
RUN pnpm install --frozen-lockfile --prod

# Copy built dist from builder
COPY --from=builder /app/packages/benson-core/dist   packages/benson-core/dist
COPY --from=builder /app/packages/dewey-core/dist    packages/dewey-core/dist
COPY --from=builder /app/packages/ext-docs/dist      packages/ext-docs/dist
COPY --from=builder /app/packages/ext-github/dist    packages/ext-github/dist
COPY --from=builder /app/packages/ext-web/dist       packages/ext-web/dist
COPY --from=builder /app/packages/maestro-core/dist  packages/maestro-core/dist
COPY --from=builder /app/packages/miranda-core/dist  packages/miranda-core/dist
COPY --from=builder /app/packages/orca-core/dist     packages/orca-core/dist
COPY --from=builder /app/packages/pappy-core/dist    packages/pappy-core/dist
COPY --from=builder /app/packages/workbench-core/dist packages/workbench-core/dist
COPY --from=builder /app/apps/runner/dist            apps/runner/dist

# Workspace dir for task outputs / sqlite db (mount a volume here in prod)
VOLUME ["/data"]

ENV NODE_ENV=production
ENV OPENROUTER_SITE_URL=https://github.com/junkyard22/Orca
ENV OPENROUTER_APP_NAME=orca-runner

# OPENROUTER_API_KEY must be supplied at runtime via --env or .env mount
# OPENROUTER_API_KEY=

ENTRYPOINT ["node", "apps/runner/dist/index.js"]
