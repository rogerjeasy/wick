/**
 * The Vega simulator follows main (`npm run vvd:follow`).
 *
 * Asks GitHub for main's newest commit and its `ci` run. When CI passed and
 * the simulator does not run that commit yet, it builds the Vega app from
 * that exact commit, in a checkout of its own (~/.wick/vvd-follow/repo, so
 * yours is never touched), starts the simulator if it has stopped, and
 * installs and launches the app. The commit is written down only once it is
 * on the simulator; a failed build or install is tried again next time.
 *
 * Run it by hand, or every five minutes with `npm run vvd:follow:watch`
 * (a macOS LaunchAgent; `npm run vvd:follow:stop` removes it). Needs `gh`
 * signed in, the `vega` CLI and the Vega SDK (docs/SETUP.md §4).
 *
 * Environment: WICK_REPO (owner/name, default rogerjeasy/wick), VVD_SERIAL
 * (the simulator's serial, found by itself when not set).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ciVerdict, nextInstall, vegaSerial } from './decide.js';

const REPO = process.env.WICK_REPO ?? 'rogerjeasy/wick';
const APP = 'com.wick.tv.main';
const STATE = join(homedir(), '.wick', 'vvd-follow');
const CHECKOUT = join(STATE, 'repo');
const INSTALLED = join(STATE, 'installed-sha');
const LOCK = join(STATE, 'lock');
const VEGA = process.env.VEGA_CLI ?? join(homedir(), 'vega', 'bin', 'vega');

const say = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);
const run = (cmd: string, args: readonly string[], cwd?: string): string =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
const ok = (cmd: string, args: readonly string[]): boolean => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;

function notify(text: string): void {
  spawnSync('osascript', ['-e', `display notification ${JSON.stringify(text)} with title "Wick on the Vega simulator"`], { stdio: 'ignore' });
}

function mainState(): { sha: string; ci: ReturnType<typeof ciVerdict> } {
  const sha = run('gh', ['api', `repos/${REPO}/commits/main`, '--jq', '.sha']);
  const raw = run('gh', ['api', `repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=1`, '--jq', '.workflow_runs[0] // empty']);
  return { sha, ci: ciVerdict(raw ? (JSON.parse(raw) as { status: string; conclusion: string | null }) : undefined) };
}

function simulatorSerial(): string | undefined {
  if (process.env.VVD_SERIAL) return process.env.VVD_SERIAL;
  const status = run(VEGA, ['virtual-device', 'status']);
  if (!/"running":\s*true/.test(status)) {
    say('starting the Vega simulator');
    run(VEGA, ['virtual-device', 'start']);
  }
  const vda = join(homedir(), 'vega', 'sdk', 'vega-sdk', 'main');
  const tools = existsSync(vda) ? run('find', [vda, '-name', 'vda', '-path', '*/bin/tools/*']).split('\n')[0] : undefined;
  const serials = tools ? [...run(tools, ['devices']).matchAll(/^(\S+)\tdevice$/gm)].map((m) => m[1]!) : [];
  // `vega device info` answers for the Android TV emulator too; only Vega's own OS has OE_VERSION in its release file.
  return vegaSerial(serials, (serial) => tools !== undefined && /\b1\b/.test(spawnSync(tools, ['-s', serial, 'shell', 'grep -c OE_VERSION /etc/os-release'], { encoding: 'utf8' }).stdout ?? ''));
}

function build(sha: string): string {
  if (!existsSync(join(CHECKOUT, '.git'))) run('gh', ['repo', 'clone', REPO, CHECKOUT, '--', '--quiet']);
  run('git', ['fetch', '--quiet', 'origin', 'main'], CHECKOUT);
  run('git', ['checkout', '--quiet', '--detach', sha], CHECKOUT);
  say(`npm ci at ${sha.slice(0, 7)}`);
  run('npm', ['ci', '--no-audit', '--no-fund'], CHECKOUT);
  const app = join(CHECKOUT, 'apps', 'tv-vega');
  rmSync(join(app, 'build', 'aarch64-release'), { recursive: true, force: true });
  say('building the Vega app (Release)');
  run('npm', ['run', 'build'], app);
  const vpkg = join(app, 'build', 'aarch64-release', 'tv-vega_aarch64.vpkg');
  if (!existsSync(vpkg)) throw new Error(`no package at ${vpkg}`);
  return vpkg;
}

function main(): void {
  mkdirSync(STATE, { recursive: true });
  // One at a time: a build takes minutes, and the agent fires every five.
  try {
    writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  } catch {
    const pid = Number(readFileSync(LOCK, 'utf8'));
    if (Number.isFinite(pid) && ok('kill', ['-0', String(pid)])) return say('another run is still going');
    writeFileSync(LOCK, String(process.pid));
  }
  try {
    const installed = existsSync(INSTALLED) ? readFileSync(INSTALLED, 'utf8').trim() : undefined;
    const now = mainState();
    const decision = nextInstall(now, installed);
    if (!decision.install) return say(`main ${now.sha.slice(0, 7)}: ${decision.why}`);

    const vpkg = build(decision.sha);
    const serial = simulatorSerial();
    if (!serial) throw new Error('no Vega simulator attached (set VVD_SERIAL if it is running)');
    say(`installing on ${serial}`);
    run(VEGA, ['run-app', '-d', serial, vpkg, APP]);
    writeFileSync(INSTALLED, `${decision.sha}\n`);
    say(`the simulator runs main ${decision.sha.slice(0, 7)}`);
    notify(`Updated to main ${decision.sha.slice(0, 7)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    say(`failed: ${message}`);
    notify(`Could not update: ${message}`);
    process.exitCode = 1;
  } finally {
    rmSync(LOCK, { force: true });
  }
}

main();
