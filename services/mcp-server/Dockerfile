# Build from the repo root: docker build -f services/mcp-server/Dockerfile .
#
# The MCP server (S4a) runs the same vite-node dev entrypoint here as it does
# locally (`npm run dev`) — there is no production build step, because the
# server's own runtime IS the TypeScript source run through vite-node's
# transform pipeline. That means this image needs devDependencies (vitest,
# vite-node, typescript) at runtime, not just dependencies — `npm ci` here is
# deliberately NOT `--omit=dev`.
#
# npm workspaces means the whole monorepo has to be present for `npm ci` to
# resolve @wick/agent -> @wick/policy/@wick/ring/@wick/contracts correctly
# (they're symlinked, not published packages) — a partial copy of just
# services/mcp-server would not install.
FROM node:22-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
COPY services ./services
COPY apps/tv-vega/package.json ./apps/tv-vega/package.json

# --ignore-scripts: simple-git-hooks' postinstall expects a .git directory
# that a container image has no reason to carry.
RUN npm ci --ignore-scripts

FROM node:22-slim

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json vitest.config.ts tsconfig.base.json ./
COPY packages ./packages
COPY services ./services

# Non-root: nothing here needs root, and the base image ships a `node` user.
# vite-node writes a small timestamped temp config file into the cwd on
# every startup — everything up to here was copied in as root, so node
# couldn't write there without this.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 3300

CMD ["npm", "run", "dev", "--workspace=@wick/mcp-server"]
