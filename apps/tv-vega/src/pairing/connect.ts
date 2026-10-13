/**
 * Getting a television its token: the one it has, a refreshed one, or a
 * code on the pairing screen and the token that comes when the code is
 * entered (PairingFlow.ts). Pure — App.tsx hands it the pairing flow and
 * draws what it says. The same for the resident's television and a family
 * member's own: whose it is, is only known once the token is there.
 *
 * It does not give up. Seen on the Vega simulator, 2026-10-13: the first
 * launch after a cold boot sat on "Getting a code…" for over a minute. One
 * request had failed, or never answered, and nothing ever asked again. So
 * every pairing request has a time limit (PairingFlow), and a try that
 * fails is tried again on a calm schedule — a few seconds at first, backing
 * off to a quarter of a minute — for as long as it takes. From the first
 * failure the screen says so, in the words Wick already uses for not
 * reaching a home, instead of claiming for ever that a code is on its way.
 *
 * Every try starts from the top: by the next one the pairing service may
 * know this television, and no code is needed at all. A code that has run
 * out is replaced by a new one, and stays on screen until the new one is
 * there.
 */
import { DEFAULT_LANGUAGE, type DeviceToken } from '@wick/contracts';
import { words } from '../words/words.js';
import type { PairingFlow, PairingStartResponse } from './PairingFlow.js';

export type Connecting =
  /**
   * The pairing screen. `info`: the code to enter. `trying`: the pairing
   * service could not be reached, and is being tried again.
   */
  | { readonly kind: 'pairing'; readonly info?: PairingStartResponse; readonly trying?: boolean }
  | { readonly kind: 'ready'; readonly token: DeviceToken };

/**
 * Said under "Getting a code…" from the first failed try. The family screen's own words (family/familyScreen.ts `unreachableLine`).
 * Read from the words table like the rest of the pairing screen, and in English always, as that screen is (words/words.ts).
 */
export const STILL_TRYING = words(DEFAULT_LANGUAGE)('pairing.stillTrying');

const FIRST_RETRY_MS = 3_000;
const LONGEST_RETRY_MS = 15_000;

/** How long to wait after this many failed tries in a row: 3 s, 6 s, 12 s, then 15 s every time. */
export function retryDelayMs(failures: number): number {
  return Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, failures - 1));
}

export interface ConnectDeps {
  /** This television's own id (deviceId.ts). */
  readonly deviceId: () => Promise<string>;
  readonly pairing: Pick<PairingFlow, 'loadToken' | 'start' | 'pollUntilBound' | 'clearToken'>;
  /**
   * A family member's television that has just been told it is no longer
   * connected (family/FamilyApp.tsx): its token is forgotten, and none is
   * asked for again — a refresh that still answered would only bring it
   * straight back. It is set up again from a new code.
   */
  readonly signedOut: boolean;
  /** Told only when what the screen should show has changed. */
  readonly onChange: (state: Connecting) => void;
}

export function connectTelevision(deps: ConnectDeps): { cancel(): void } {
  let cancelled = false;
  let said: string | undefined;
  let waking: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const say = (state: Connecting): void => {
    if (cancelled) return;
    const saying = JSON.stringify(state);
    if (saying === said) return;
    said = saying;
    deps.onChange(state);
  };

  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      waking = resolve;
      timer = setTimeout(resolve, ms);
    });

  void (async () => {
    let failures = 0;
    let forgotten = false;
    while (!cancelled) {
      try {
        const deviceId = await deps.deviceId();
        if (deps.signedOut && !forgotten) {
          await deps.pairing.clearToken();
          forgotten = true;
        }
        const token = deps.signedOut ? null : await deps.pairing.loadToken(deviceId);
        if (cancelled) return;
        if (token) return say({ kind: 'ready', token });

        const info = await deps.pairing.start(deviceId);
        if (cancelled) return;
        failures = 0;
        say({ kind: 'pairing', info });
        try {
          const bound = await deps.pairing.pollUntilBound(info.code);
          return say({ kind: 'ready', token: bound });
        } catch (err) {
          // The code ran out, or was never entered. Not a failure to reach
          // anything: a new one is fetched after a short pause, and this
          // one stays on screen until it is there.
          console.error('pairing_poll_failed', err);
          await pause(retryDelayMs(1));
        }
      } catch {
        // Not reached, or not answered in time. Said, and tried again.
        failures += 1;
        say({ kind: 'pairing', trying: true });
        await pause(retryDelayMs(failures));
      }
    }
  })();

  return {
    cancel(): void {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      waking?.();
    },
  };
}
