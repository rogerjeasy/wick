/**
 * Is the deployed stack up, and does it behave?
 *
 *   npm run smoke:live
 *
 * .github/workflows/smoke.yml runs this after every deploy to main, every
 * night, and on demand; it runs the same from a laptop and needs no AWS
 * credentials. One line per check; exits 1 if any fails. What each check
 * decides is scripts/smoke/checks.ts, and the order they are asked in is
 * scripts/smoke/run.ts.
 *
 * Another stack: set WICK_FAMILY_APP_URL, WICK_VIRTUAL_TV_URL,
 * WICK_SERVER_URL and WICK_STATUS_URL (from `terraform -chdir=infra output`).
 */
import { fileURLToPath } from 'node:url';
import { countRegisteredTools, featuresIn, FEATURE_MARKERS, FEATURE_PRS, LIVE, toolSources, type CheckResult } from './smoke/checks.js';
import { runSmoke } from './smoke/run.js';
import type { Fetch } from './addon/preflight.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MARK = { pass: '✓', fail: '✗', skip: '–', info: '·' } as const;
const TIMEOUT_MS = 30_000;

/** Every request gives up after 30 seconds, so a hung endpoint is a failed check, not a hung job. */
const timedFetch: Fetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

async function main(): Promise<void> {
  const trim = (url: string) => url.replace(/\/+$/, '');
  const features = featuresIn(ROOT);
  const config = {
    familyApp: trim(process.env.WICK_FAMILY_APP_URL || LIVE.familyApp),
    virtualTv: trim(process.env.WICK_VIRTUAL_TV_URL || LIVE.virtualTv),
    server: trim(process.env.WICK_SERVER_URL || LIVE.server),
    status: process.env.WICK_STATUS_URL || LIVE.status,
    features,
    expectedTools: countRegisteredTools(toolSources(ROOT)),
  };

  console.log(`live smoke test of ${config.server}`);
  for (const [feature, on] of Object.entries(features) as [keyof typeof features, boolean][]) {
    console.log(`  ${MARK.info} ${feature} (${FEATURE_PRS[feature]}): ${on ? 'in this checkout, so required' : `not in this checkout (${FEATURE_MARKERS[feature]}), checked only if live`}`);
  }
  const say = (r: CheckResult) => console.log(`  ${MARK[r.outcome]} ${r.name}: ${r.detail}`);
  const failures = await runSmoke(config, timedFetch, say);
  console.log(failures === 0 ? 'live' : `${failures} problem${failures === 1 ? '' : 's'}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
