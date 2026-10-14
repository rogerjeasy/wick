# The "wick_agents" Bedrock AgentCore Runtime (infra/agentcore.tf).
# Build from the repo root, for arm64 — AgentCore Runtime runs arm64 only:
#
#   docker buildx build --platform linux/arm64 -f services/agent/Dockerfile .
#
# Stage 1 bundles services/agent/src/runtime/main.ts (Strands graphs, werift,
# the AWS SDK) into one ESM file with the same script the Lambdas use.
# Stage 2 is that file plus ffmpeg — the live bridge's HLS muxer (live/hls.ts).
# No credentials are baked in: the execution role and Secrets Manager supply
# them at runtime (AGENTS.md, Credential rules).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY scripts/build-lambda.mjs ./scripts/build-lambda.mjs
# The stand-in doorbell's pictures: build-lambda.mjs copies them beside the door Lambda.
COPY docs/demo-door ./docs/demo-door
COPY apps/tv-vega/package.json ./apps/tv-vega/package.json
# --ignore-scripts: simple-git-hooks' postinstall expects a .git directory.
# esbuild's own postinstall is the one script the build needs.
# Retries: one stalled registry fetch shouldn't fail a deploy (seen twice).
RUN npm ci --ignore-scripts --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000 \
 && node node_modules/esbuild/install.js \
 && node scripts/build-lambda.mjs

FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/services/agent/.build/runtime/main.mjs ./main.mjs

# Non-root; /tmp is where live/io.ts keeps the per-session HLS scratch dir.
USER node
ENV NODE_ENV=production PORT=8080 FFMPEG_PATH=/usr/bin/ffmpeg LIVE_WORKDIR=/tmp/wick-live
# AgentCore Runtime's service contract: /ping and /invocations on 8080.
EXPOSE 8080
CMD ["node", "main.mjs"]
