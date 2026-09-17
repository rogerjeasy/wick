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
 * @aws-sdk/* is left external: the nodejs22.x Lambda runtime provides it,
 * the same assumption services/edge-ring/lambda/*.mjs already makes.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

const TARGETS = [
  {
    name: 'agent-door-event',
    entry: 'services/agent/src/agents/door/lambda.ts',
    outfile: 'services/agent/.build/door-event/index.mjs',
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
    external: ['@aws-sdk/*'],
    logLevel: 'info',
  });
  console.log(`built ${target.name} -> ${target.outfile}`);
}
