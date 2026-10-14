#!/usr/bin/env node
/**
 * Bundles TS Lambda entrypoints that cross workspace-package boundaries
 * (@wick/agent -> @wick/ring, @wick/policy, @wick/contracts) into a single
 * self-contained file each, so Terraform's archive_file can zip a plain
 * output directory the same way it already does for services/edge-ring and
 * services/edge-device's hand-written .mjs Lambdas.
 *
 * Those services stay plain .mjs on purpose — they only ever touch
 * @aws-sdk/*. This script exists for the one Lambda that legitimately needs
 * the workspace's TS packages at runtime.
 *
 *   node scripts/build-lambda.mjs
 *
 * @aws-sdk/* is left external where the nodejs22.x Lambda runtime provides
 * it (the same assumption services/edge-ring/lambda/*.mjs makes) — except
 * for targets that reach the agent plane: @aws-sdk/client-bedrock-agentcore
 * is new enough that the runtime's bundled SDK can't be counted on, so those
 * bundle everything (`bundleAll`). The AgentCore Runtime container has no
 * SDK at all, so it bundles everything too.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

const TARGETS = [
  {
    name: 'agent-door-event',
    entry: 'services/agent/src/agents/door/lambda.ts',
    outfile: 'services/agent/.build/door-event/index.mjs',
    bundleAll: true,
    // A demo home's stand-in doorbell (agents/door/demoDoor.ts) reads its
    // pictures from beside the bundle, for the vision step. The same files
    // GitHub Pages publishes from docs/ for the television to load.
    copy: [{ from: 'docs/demo-door', to: 'services/agent/.build/door-event/demo-door', match: /\.jpg$/ }],
  },
  {
    // M1: EventBridge card.action -> AgentCore door-action graph.
    name: 'agent-card-action',
    entry: 'services/agent/src/agents/door/actionLambda.ts',
    outfile: 'services/agent/.build/card-action/index.mjs',
    bundleAll: true,
  },
  {
    // M2: POST/DELETE /live/sessions -> AgentCore live graph.
    name: 'agent-live',
    entry: 'services/agent/src/live/lambda.ts',
    outfile: 'services/agent/.build/live/index.mjs',
    bundleAll: true,
  },
  {
    // M2: the WHEP->HLS bridge, a container-image Lambda (services/agent/bridge.Dockerfile).
    name: 'agent-live-bridge',
    entry: 'services/agent/src/live/bridgeLambda.ts',
    outfile: 'services/agent/.build/live-bridge/index.mjs',
    bundleAll: true,
  },
  {
    // The AgentCore Runtime container (services/agent/Dockerfile).
    name: 'agent-runtime',
    entry: 'services/agent/src/runtime/main.ts',
    outfile: 'services/agent/.build/runtime/main.mjs',
    bundleAll: true,
  },
  {
    name: 'agent-narrator-weekly',
    entry: 'services/agent/src/agents/narrator/lambda.ts',
    outfile: 'services/agent/.build/narrator-weekly/index.mjs',
  },
];

for (const target of TARGETS) {
  await build({
    entryPoints: [path.join(root, target.entry)],
    outfile: path.join(root, target.outfile),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: target.bundleAll ? [] : ['@aws-sdk/*'],
    // Bundled CommonJS dependencies (werift's, the SDK's) still call require()
    // for Node built-ins; give the ESM bundle one.
    banner: target.bundleAll
      ? { js: "import { createRequire as __wickCreateRequire } from 'node:module'; const require = __wickCreateRequire(import.meta.url);" }
      : {},
    logLevel: 'info',
  });
  for (const { from, to, match } of target.copy ?? []) {
    const files = (await readdir(path.join(root, from))).filter((name) => match.test(name));
    if (files.length === 0) throw new Error(`${target.name}: nothing to copy from ${from}`);
    await mkdir(path.join(root, to), { recursive: true });
    for (const name of files) await copyFile(path.join(root, from, name), path.join(root, to, name));
    console.log(`copied ${files.length} file(s) ${from} -> ${to}`);
  }
  console.log(`built ${target.name} -> ${target.outfile}`);
}
