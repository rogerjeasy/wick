import { describe, expect, it } from 'vitest';
import { ciVerdict, launchAgentPlist, nextInstall, vegaSerial } from '../vvd-follow/decide.js';

describe('nextInstall — the simulator follows main, once main is green', () => {
  it('installs a main whose CI passed and that is not on the simulator yet', () => {
    expect(nextInstall({ sha: 'b2', ci: 'success' }, 'a1')).toEqual({ install: true, sha: 'b2' });
    expect(nextInstall({ sha: 'b2', ci: 'success' }, undefined)).toEqual({ install: true, sha: 'b2' });
  });

  it('waits for CI, and never installs a main that failed', () => {
    expect(nextInstall({ sha: 'b2', ci: 'pending' }, 'a1')).toEqual({ install: false, why: 'ci_pending' });
    expect(nextInstall({ sha: 'b2', ci: 'failure' }, 'a1')).toEqual({ install: false, why: 'ci_failed' });
    expect(nextInstall({ sha: 'b2', ci: 'none' }, 'a1')).toEqual({ install: false, why: 'ci_pending' });
  });

  it('does nothing when the simulator already runs that main', () => {
    expect(nextInstall({ sha: 'b2', ci: 'success' }, 'b2')).toEqual({ install: false, why: 'already_installed' });
  });
});

describe('ciVerdict — what GitHub says about main’s CI run', () => {
  it('reads a finished run by its conclusion, and anything unfinished or missing as pending', () => {
    expect(ciVerdict({ status: 'completed', conclusion: 'success' })).toBe('success');
    expect(ciVerdict({ status: 'completed', conclusion: 'failure' })).toBe('failure');
    expect(ciVerdict({ status: 'completed', conclusion: 'cancelled' })).toBe('failure');
    expect(ciVerdict({ status: 'in_progress', conclusion: null })).toBe('pending');
    expect(ciVerdict(undefined)).toBe('none');
  });
});

describe('vegaSerial — which attached emulator is the Vega simulator', () => {
  it('takes the first serial the Vega CLI answers for, and none when it answers for none', () => {
    expect(vegaSerial(['emulator-5554', 'emulator-5556'], (s) => s === 'emulator-5556')).toBe('emulator-5556');
    expect(vegaSerial(['emulator-5554'], () => false)).toBeUndefined();
  });
});

describe('launchAgentPlist — the macOS agent that runs it every few minutes', () => {
  it('runs the follower from the checkout it is given, in a login shell so gh, vega and node are on the path, and logs beside its state', () => {
    const plist = launchAgentPlist({ repo: '/Users/me/wick', home: '/Users/me', everySeconds: 300 });
    expect(plist).toContain('<string>com.wick.vvd-follow</string>');
    expect(plist).toContain('<string>/bin/zsh</string>');
    expect(plist).toContain("cd '/Users/me/wick' &amp;&amp; npm run --silent vvd:follow");
    expect(plist).toContain('<integer>300</integer>');
    expect(plist).toContain('<string>/Users/me/.wick/vvd-follow/follow.log</string>');
  });
});
