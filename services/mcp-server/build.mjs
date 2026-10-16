#!/usr/bin/env node
/**
 * The Wick server, built ahead of time: src/index.ts and everything it
 * imports — the workspace's own TypeScript packages (@wick/agent,
 * @wick/policy, @wick/contracts), Express, the MCP SDK and the AWS SDK —
 * bundled by esbuild into one ESM file that plain `node` runs.
 *
 *   npm run build --workspace=@wick/mcp-server   # -> services/mcp-server/.build/server.mjs
 *
 * The image (Dockerfile) is that file and a Node runtime: no node_modules,
 * no TypeScript, no vite-node. Nothing is left external, because nothing in
 * the runtime image could provide it. The same approach as the agent's
 * container (scripts/build-lambda.mjs, services/agent/Dockerfile).
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

const result = await build({
  absWorkingDir: here,
  entryPoints: ['src/index.ts'],
  outfile: '.build/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // A stack trace in the log names the TypeScript line (node --enable-source-maps).
  sourcemap: true,
  // Bundled CommonJS dependencies (Express's, the SDK's) still call require()
  // for Node built-ins; give the ESM bundle one.
  banner: { js: "import { createRequire as __wickCreateRequire } from 'node:module'; const require = __wickCreateRequire(import.meta.url);" },
  metafile: true,
  logLevel: 'info',
});

const bytes = Object.values(result.metafile.outputs).reduce((sum, out) => sum + out.bytes, 0);
console.log(`built services/mcp-server/.build/server.mjs (${(bytes / 1024 / 1024).toFixed(1)} MB with its source map)`);
