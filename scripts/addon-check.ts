/**
 * Is the Alexa+ add-on package ready to deploy?
 *
 *   npm run addon:check                 the manifest alone, no network
 *   npm run addon:check -- --live       and the files and server it names
 *   npm run addon:check -- --live --demo   …signing in as a demo guest
 *
 * The deploy itself (`alexa-ai deploy`) cannot be run: Amazon's MCP Toolkit
 * is open to select partners only (FRICTION.md FL-001). This runs what that
 * deploy is documented to need, so the package is known good on the day
 * access opens — and so the claim "the add-on is ready" is checked, not said.
 *
 * `--live` asks the deployed stack. With a token (WICK_ADDON_CHECK_TOKEN, or
 * `--demo` to make a guest the way the family app's demo button does) it
 * also says hello to the MCP server, lists its tools and calls one that only
 * reads. It never calls a tool that writes, and never prints a token.
 * Exits 1 if anything fails.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkManifest, manifestEndpoint } from './addon/manifest-rules.js';
import { checkAuthMetadata, checkImages, checkLegalPages, checkMcp, checkUnauthenticated, type CheckResult } from './addon/preflight.js';
import { demoToken } from './addon/demo-token.js';

const MANIFEST_PATH = fileURLToPath(new URL('../addon-package/addon.json', import.meta.url));
const MARK = { pass: '✓', fail: '✗', skip: '–' } as const;

function report(results: CheckResult[]): number {
  for (const r of results) console.log(`  ${MARK[r.outcome]} ${r.name}: ${r.detail}`);
  return results.filter((r) => r.outcome === 'fail').length;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const manifest: unknown = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

  console.log('manifest (addon-package/addon.json)');
  const findings = checkManifest(manifest);
  for (const f of findings) console.log(`  ${MARK.fail} ${f.path || 'manifest'} ${f.problem}`);
  if (findings.length === 0) console.log(`  ${MARK.pass} holds every required field, within its limits`);
  let failures = findings.length;

  const endpoint = manifestEndpoint(manifest);
  if (args.has('--live') && endpoint && failures === 0) {
    console.log('published files');
    failures += report([...(await checkImages(manifest, fetch)), ...(await checkLegalPages(manifest, fetch))]);

    console.log(`MCP server (${endpoint})`);
    failures += report([await checkUnauthenticated(endpoint, fetch), await checkAuthMetadata(endpoint, fetch)]);

    let token = process.env.WICK_ADDON_CHECK_TOKEN;
    if (!token && args.has('--demo')) {
      try {
        token = await demoToken(new URL(endpoint).origin, fetch);
        console.log(`  ${MARK.pass} signed in as a demo guest`);
      } catch (err) {
        console.log(`  ${MARK.fail} demo sign-in: ${err instanceof Error ? err.message : String(err)}`);
        failures += 1;
      }
    }
    if (token) failures += report(await checkMcp(endpoint, token, fetch));
    else console.log(`  ${MARK.skip} hello, tools and timings: no token (set WICK_ADDON_CHECK_TOKEN, or pass --demo)`);
  } else if (args.has('--live')) {
    console.log('live checks not run: the manifest must pass first');
  }

  console.log(failures === 0 ? 'ready' : `${failures} problem${failures === 1 ? '' : 's'}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
