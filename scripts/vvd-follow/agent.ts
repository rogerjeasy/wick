/**
 * Turns the simulator's follower on or off as a macOS LaunchAgent.
 *
 *   npm run vvd:follow:watch   runs `npm run vvd:follow` every five minutes
 *   npm run vvd:follow:stop    stops it and removes the agent
 *
 * The agent runs from the follower's own checkout (~/.wick/vvd-follow/repo,
 * made here on main), never from yours: that checkout moves to each green
 * main it installs, so the follower runs the newest version of itself.
 *
 * The log is ~/.wick/vvd-follow/follow.log.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LAUNCH_AGENT_LABEL, launchAgentPlist } from './decide.js';

const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
const launchctl = (...args: string[]) => spawnSync('launchctl', args, { stdio: 'inherit' });

if (process.argv.includes('--stop')) {
  if (existsSync(plistPath)) launchctl('unload', plistPath);
  rmSync(plistPath, { force: true });
  console.log('The Vega simulator no longer follows main.');
} else {
  const checkout = join(homedir(), '.wick', 'vvd-follow', 'repo');
  const sh = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
  mkdirSync(join(homedir(), '.wick', 'vvd-follow'), { recursive: true });
  if (!existsSync(join(checkout, '.git'))) sh('gh', ['repo', 'clone', process.env.WICK_REPO ?? 'rogerjeasy/wick', checkout, '--', '--quiet']);
  sh('git', ['fetch', '--quiet', 'origin', 'main'], checkout);
  sh('git', ['checkout', '--quiet', '--detach', 'origin/main'], checkout);
  sh('npm', ['ci', '--no-audit', '--no-fund'], checkout);
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  if (existsSync(plistPath)) launchctl('unload', plistPath);
  writeFileSync(plistPath, launchAgentPlist({ repo: checkout, home: homedir(), everySeconds: 300 }));
  launchctl('load', plistPath);
  console.log(`The Vega simulator follows main: checked every 5 minutes. Log: ${join(homedir(), '.wick', 'vvd-follow', 'follow.log')}`);
}
