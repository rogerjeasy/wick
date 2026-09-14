#!/usr/bin/env node
/**
 * CI guard for WICK-TECHNICAL.md §12.1 and §3.3.
 *
 * The Vega samples ship ContentPersonalizationMocks wired into the real service
 * path. Shipping that would break the submission's "no simulated data" constraint
 * in the most visible place in the repo. This fails the build if any runtime
 * module under apps/tv-vega/src imports something matching /mock/i.
 *
 * Test fixtures are fine — but they live under __tests__ and never ship.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCAN = join(ROOT, 'apps/tv-vega/src');
const IMPORT_RE = /\b(?:import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
const offenders = [];

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === '__tests__' || e === 'node_modules') continue;
      walk(p);
    } else if (/\.(ts|tsx|js|jsx)$/.test(e)) {
      const src = readFileSync(p, 'utf8');
      for (const m of src.matchAll(IMPORT_RE)) {
        if (/mock/i.test(m[1])) offenders.push(`${relative(ROOT, p)} -> ${m[1]}`);
      }
    }
  }
}

walk(SCAN);

if (offenders.length) {
  console.error('\n  Mock imports found in Vega runtime code (see WICK-TECHNICAL.md §12.1):\n');
  for (const o of offenders) console.error(`   - ${o}`);
  console.error('\n  Runtime code must use real data. Fixtures belong under __tests__.\n');
  process.exit(1);
}
console.log('check:no-mocks — clean');
