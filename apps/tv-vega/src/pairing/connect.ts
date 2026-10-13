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
 *
 * And the screen is never left blank while the first request has not
 * answered (seen on both televisions, 2026-10-13: nothing at all for ten
 * seconds, and longer). After HOLD_AFTER_MS with nothing to show:
 *
 *   - a television that remembers a token — connected before, where the
 *     disk keeps one — is given that token, run out or not, and shows its
 *     own screen with it: the resident's home with what it has, a family
 *     member's heading. It is not shown the pairing screen for a network
 *     that is only slow, or gone; it is given its fresh token when the
 *     pairing service answers, and the pairing screen only if the service
 *     says it is no longer connected.
 *   - a television that remembers nothing shows the pairing screen.
 *
 * Not at once: a television that keeps no token on disk — every Vega
 * simulator — asks for its token at each launch and is answered in a few
 * hundred milliseconds; shown the pairing screen at once, it would flash
 * "Set up Wick" at every launch. In that first second nothing is shown, as
 * before, and a television that is answered in time shows only its own
 * screen.
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
  /**
   * `asked`: the token is fresh from the pairing service — a refresh, or
   * the code just entered — so the service has just said this television is
   * connected. A token only read from the disk has asked nobody
   * (standing.ts asks, then).
   */
  | { readonly kind: 'ready'; readonly token: DeviceToken; readonly asked?: true };

/**
 * Said under "Getting a code…" from the first failed try. The family screen's own words (family/familyScreen.ts `unreachableLine`).
 * Read from the words table like the rest of the pairing screen, and in English always, as that screen is (words/words.ts).
 */
export const STILL_TRYING = words(DEFAULT_LANGUAGE)('pairing.stillTrying');

/**
 * How long the first request is given before the screen says something
 * without it. The same second the resident's home may stay undrawn while
 * its language is read (ResidentApp.tsx): long enough for an answer on a
 * working network, short enough that nobody takes the television for dead.
 */
export const HOLD_AFTER_MS = 1_000;

const FIRST_RETRY_MS = 3_000;
const LONGEST_RETRY_MS = 15_000;

/** How long to wait after this many failed tries in a row: 3 s, 6 s, 12 s, then 15 s every time. */
export function retryDelayMs(failures: number): number {
  return Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, failures - 1));
}

export interface ConnectDeps {
  /** This television's own id (deviceId.ts). */
  readonly deviceId: () => Promise<string>;
  readonly pairing: Pick<PairingFlow, 'loadToken' | 'start' | 'pollUntilBound' | 'clearToken' | 'rememberedToken'>;
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

  /** What this television last held, read once. Never for one just told it is no longer connected; and a disk that cannot be read remembers nothing. */
  let remembering: Promise<DeviceToken | null> | undefined;
  const remembered = (): Promise<DeviceToken | null> => {
    remembering ??= deps.signedOut ? Promise.resolve(null) : deps.pairing.rememberedToken().catch(() => null);
    return remembering;
  };
  /** Once a code has been on screen this television is being set up: an old token is not gone back to. */
  let codeShown = false;

  /**
   * What to show when the pairing service has not answered, or could not
   * be reached: a television's own screen, with the token it remembers —
   * or, for one that remembers nothing, the pairing screen.
   */
  const withoutAnAnswer = async (trying: boolean): Promise<void> => {
    const token = codeShown ? null : await remembered();
    if (token) say({ kind: 'ready', token });
    else say(trying ? { kind: 'pairing', trying: true } : { kind: 'pairing' });
  };

  // Nothing to show after a second: say something without the answer.
  const holding = setTimeout(() => {
    if (said === undefined) void withoutAnAnswer(false).then(undefined, () => undefined);
  }, HOLD_AFTER_MS);

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
        // What the disk held before anything was asked: a token that comes back the same was only read from it.
        const before = await remembered();
        const token = deps.signedOut ? null : await deps.pairing.loadToken(deviceId);
        if (cancelled) return;
        if (token) return say(token.jwt === before?.jwt ? { kind: 'ready', token } : { kind: 'ready', token, asked: true });

        const info = await deps.pairing.start(deviceId);
        if (cancelled) return;
        failures = 0;
        codeShown = true;
        say({ kind: 'pairing', info });
        try {
          const bound = await deps.pairing.pollUntilBound(info.code);
          return say({ kind: 'ready', token: bound, asked: true });
        } catch (err) {
          // The code ran out, or was never entered. Not a failure to reach
          // anything: a new one is fetched after a short pause, and this
          // one stays on screen until it is there.
          console.error('pairing_poll_failed', err);
          await pause(retryDelayMs(1));
        }
      } catch {
        // Not reached, or not answered in time. Said — on the pairing
        // screen, or not at all on a television showing its own — and
        // tried again.
        failures += 1;
        await withoutAnAnswer(true);
        await pause(retryDelayMs(failures));
      }
    }
  })();

  return {
    cancel(): void {
      cancelled = true;
      clearTimeout(holding);
      if (timer !== undefined) clearTimeout(timer);
      waking?.();
    },
  };
}
