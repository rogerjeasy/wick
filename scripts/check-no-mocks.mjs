#!/usr/bin/env node
/**
 * CI guard for WICK-TECHNICAL.md §12.1 and §3.3.
 *
 * The Vega samples ship ContentPersonalizationMocks wired into the real service
 * path. Shipping that would break the submission's "no simulated data" constraint
 * in the most visible place in the repo. This fails the build if any runtime
 * module under apps/tv-vega/src or apps/tv-fireos/src imports something
 * matching /mock/i.
 *
 * What counts as importing is TypeScript's own answer, not a pattern of ours:
 * `ts.preProcessFile` lists every module a file names — `import … from`,
 * `import type … from`, `export … from`, a bare `import '…'`, `import(…)` and
 * `require(…)` — and skips comments and strings. The pattern this guard used
 * before only knew the last three forms, so `import { X } from './mocks/x'`,
 * the usual one, went through (scripts/__tests__/check-no-mocks.test.ts).
 *
 * Test fixtures are fine — but they live under __tests__ and never ship.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// The Fire OS app bundles the Vega app's source and adds adapters of its own.
export const SCANNED = ['apps/tv-vega/src', 'apps/tv-fireos/src'];
const MOCK = /mock/i;

/** Every module a source file names, as TypeScript reads it. */
export function importsOf(source) {
  return ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName);
}

/** The modules a source file names that look like mocks. */
export function mockImports(source) {
  return importsOf(source).filter((name) => MOCK.test(name));
}

/** `file -> module` for every runtime file under `dirs` (relative to `root`) that imports a mock. */
export function findMockImports(dirs = SCANNED, root = ROOT) {
  const offenders = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) {
        if (e === '__tests__' || e === 'node_modules') continue;
        walk(p);
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e)) {
        for (const name of mockImports(readFileSync(p, 'utf8'))) offenders.push(`${relative(root, p)} -> ${name}`);
      }
    }
  };
  for (const dir of dirs) walk(join(root, dir));
  return offenders;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const offenders = findMockImports();
  if (offenders.length) {
    console.error('\n  Mock imports found in television runtime code (see WICK-TECHNICAL.md §12.1):\n');
    for (const o of offenders) console.error(`   - ${o}`);
    console.error('\n  Runtime code must use real data. Fixtures belong under __tests__.\n');
    process.exit(1);
  }
  console.log('check:no-mocks — clean');
}
