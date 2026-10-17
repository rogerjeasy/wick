/**
 * The Vega simulator follows main: the pure part. When main has a new commit
 * whose CI passed, and the simulator does not run it yet, it is built and
 * installed (run.ts). Nothing here touches git, GitHub or the simulator.
 */

export type CiState = 'success' | 'failure' | 'pending' | 'none';

export interface MainState {
  readonly sha: string;
  readonly ci: CiState;
}

export type Decision = { readonly install: true; readonly sha: string } | { readonly install: false; readonly why: 'ci_pending' | 'ci_failed' | 'already_installed' };

/** Whether to build and install main now, given what the simulator was last given. */
export function nextInstall(main: MainState, installed: string | undefined): Decision {
  if (main.ci === 'failure') return { install: false, why: 'ci_failed' };
  if (main.ci !== 'success') return { install: false, why: 'ci_pending' };
  if (installed === main.sha) return { install: false, why: 'already_installed' };
  return { install: true, sha: main.sha };
}

/** GitHub's newest `ci` run for a commit, as a verdict. A run cancelled or timed out is not a pass. */
export function ciVerdict(run: { readonly status: string; readonly conclusion: string | null } | undefined): CiState {
  if (!run) return 'none';
  if (run.status !== 'completed') return 'pending';
  return run.conclusion === 'success' ? 'success' : 'failure';
}

/** The attached emulator the Vega CLI recognises (an Android TV emulator is attached beside it, and is not). */
export function vegaSerial(serials: readonly string[], isVega: (serial: string) => boolean): string | undefined {
  return serials.find(isVega);
}

export const LAUNCH_AGENT_LABEL = 'com.wick.vvd-follow';

const xml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A LaunchAgent that runs `npm run vvd:follow` from this checkout every `everySeconds`. */
export function launchAgentPlist(at: { readonly repo: string; readonly home: string; readonly everySeconds: number }): string {
  const log = `${at.home}/.wick/vvd-follow/follow.log`;
  const command = `cd '${at.repo.replace(/'/g, `'\\''`)}' && npm run --silent vvd:follow`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xml(command)}</string>
  </array>
  <key>StartInterval</key>
  <integer>${at.everySeconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}
