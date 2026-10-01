# The live bridge Lambda (M2) — container image, arm64:
#
#   DOCKER_BUILDKIT=0 docker build -f services/agent/bridge.Dockerfile .   (on an arm64 host)
#
# A Lambda rather than the AgentCore runtime because WebRTC needs outbound
# UDP, which a Lambda has and the AgentCore microVM doesn't (FRICTION.md
# FL-017). Lambda's Amazon Linux base has no ffmpeg package, so a static
# build is copied in. No credentials baked in: the execution role and Secrets
# Manager supply them at runtime.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY scripts/build-lambda.mjs ./scripts/build-lambda.mjs
COPY apps/tv-vega/package.json ./apps/tv-vega/package.json
# Retries: one stalled registry fetch shouldn't fail a deploy.
RUN npm ci --ignore-scripts --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000 \
 && node node_modules/esbuild/install.js \
 && node scripts/build-lambda.mjs

FROM mwader/static-ffmpeg:7.1 AS ffmpeg

FROM public.ecr.aws/lambda/nodejs:22
COPY --from=ffmpeg /ffmpeg /opt/ffmpeg
COPY --from=build /app/services/agent/.build/live-bridge/index.mjs ${LAMBDA_TASK_ROOT}/index.mjs
ENV FFMPEG_PATH=/opt/ffmpeg LIVE_WORKDIR=/tmp/wick-live
CMD ["index.handler"]
