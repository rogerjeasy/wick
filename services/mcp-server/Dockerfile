# The Wick server (S4a), for App Runner, which runs linux/amd64.
# Build from the repo root:
#
#   docker buildx build --platform linux/amd64 --build-arg WICK_COMMIT=$(git rev-parse --short=7 HEAD) \
#     -f services/mcp-server/Dockerfile .
#
# Stage 1 installs the monorepo — npm workspaces symlink @wick/agent,
# @wick/policy and @wick/contracts rather than publish them, so a partial
# copy of services/mcp-server would not install — and bundles src/index.ts
# and everything it imports into one ESM file (services/mcp-server/build.mjs).
# Stage 2 is that file and a Node runtime: no node_modules, no TypeScript,
# no vite-node, no npm in the process tree. Nothing is compiled while a
# request waits.
#
# No credentials are baked in: the instance role supplies them at runtime
# (AGENTS.md, Credential rules), and the server starts without any far enough
# to answer GET /health.
#
# The base image is one exact Node release, by tag and by the digest of its
# multi-platform index, in both stages: a rebuild of the same commit gets the
# same runtime. Move both lines together.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY apps/tv-vega/package.json ./apps/tv-vega/package.json

# --ignore-scripts: simple-git-hooks' postinstall expects a .git directory
# that a container image has no reason to carry. esbuild's own postinstall is
# the one script the build needs. Retries: one stalled registry fetch
# shouldn't fail a deploy.
RUN npm ci --ignore-scripts --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000 \
 && node node_modules/esbuild/install.js \
 && node services/mcp-server/build.mjs

FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

WORKDIR /app

# Read-only to the server: owned by root, run as `node`. Nothing writes here.
COPY --from=build /app/services/mcp-server/.build/server.mjs /app/services/mcp-server/.build/server.mjs.map ./

# The commit this image was built from, for GET /health. CI and
# scripts/push-mcp-image.sh pass the short SHA they tag the image with.
ARG WICK_COMMIT=""
ENV NODE_ENV=production WICK_COMMIT=${WICK_COMMIT}

# Non-root: nothing here needs root, and the base image ships a `node` user.
USER node
EXPOSE 3300

# node is PID 1 and receives App Runner's SIGTERM itself (lifecycle.ts drains, then exits 0).
CMD ["node", "--enable-source-maps", "server.mjs"]
