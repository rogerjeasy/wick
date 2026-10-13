/**
 * What the background service does on a family member's own television
 * (headless/CardService.ts hands over to this): it holds NO card channel.
 * Every FAMILY_TV_WAITING_EVERY_MS it asks the Wick server whether anything
 * waits for that member (`GET /tv/waiting`), and puts up one system toast
 * for each new thing (notify/waitingToast.ts). The server answers an empty
 * list while the app itself is on screen, so nothing here needs to know
 * whether it is.
 *
 * Each thing is said once in the life of this process: `said` remembers
 * every id announced, and one that goes away and comes back is not
 * announced again.
 *
 * The token. Where the television's disk keeps one, it is the television's
 * own. Where it keeps nothing (the Vega simulator, FL-013) it is a narrow
 * one, good for this one question, minted for the service inside a short
 * way the app opens at the pairing service (edge-device pair-refresh.mjs).
 * A narrow token cannot be brought back once it has run out, so it is
 * renewed at three quarters of its life. If it is ever refused — run out
 * while the television slept, or revoked — the service falls silent and
 * knocks at the pairing service every KNOCK_EVERY_MS: it is let in again
 * the next time the app is on screen and opens the way, and never
 * otherwise.
 *
 * Pure: it is given the asking, the knocking and the announcing.
 */
import { FAMILY_TV_WAITING_EVERY_MS, type DeviceToken } from '@wick/contracts';
import type { FamilyClient } from '../family/familyClient.js';
import { repeat, type Repeating } from '../family/repeat.js';
import type { ToastContent } from '../notify/doorToast.js';
import { waitingToast } from '../notify/waitingToast.js';
import { isNarrowToken, type ServiceClaim } from '../pairing/PairingFlow.js';

/** How often a service with no token knocks. Three knocks fall inside the ninety seconds a way stays open. */
export const KNOCK_EVERY_MS = 30_000;
/** How long a knock is waited for. One that never answers must not hold up the next: the service asks one thing at a time. */
export const KNOCK_TIMEOUT_MS = 10_000;
/**
 * Three quarters of the hour the pairing service gives a refreshed token
 * (edge-device pairing-code.mjs REFRESH_TOKEN_TTL_SEC). Counted on this
 * television from when the token was handed over, so a clock that is hours
 * out changes nothing.
 */
export const NARROW_RENEW_AFTER_MS = 45 * 60 * 1000;
/** A renewal that could not be asked is tried again this soon: many times over, inside the quarter that is left. */
export const RENEW_RETRY_MS = 60 * 1000;

/**
 * When to renew a narrow token just handed over: at three quarters of what
 * is left of it by its own expiry — when this television's clock can be
 * believed. A token that by this clock has already run out, or lasts
 * longer than the pairing service ever gives, says the clock is wrong (the
 * Vega Virtual Device's has been seen 6.9 hours out): then it is three
 * quarters of the hour.
 */
export function renewAfterMs(token: DeviceToken, now: number): number {
  const left = token.expiresAt - now;
  const believable = left > 0 && left * 0.75 <= NARROW_RENEW_AFTER_MS;
  return believable ? left * 0.75 : NARROW_RENEW_AFTER_MS;
}

export type WaitingClient = Pick<FamilyClient, 'waiting' | 'renewNow'>;
export type Claimed = ServiceClaim;

export interface WaitingServiceDeps {
  /** One knock at the pairing service, without a token (PairingFlow.claimForService). */
  readonly claim: () => Promise<Claimed>;
  /** What waits, asked with one token, and that token renewed. Made afresh for each token the service comes to hold. */
  readonly clientFor: (token: DeviceToken) => WaitingClient;
  readonly announce: (toast: ToastContent) => void;
  /** Every id announced in the life of this process. */
  readonly said: Set<string>;
}

export interface WaitingService {
  stop(): void;
}

/**
 * @param first  the token the service already has, if it has one. Without it, the service starts by knocking.
 */
export function runWaitingService(first: DeviceToken | undefined, deps: WaitingServiceDeps): WaitingService {
  let stopped = false;
  let asking: Repeating | undefined;
  let knocking: Repeating | undefined;
  let renewing: ReturnType<typeof setTimeout> | undefined;
  /** Counts the tokens served with, so an answer about an earlier one changes nothing. */
  let serving = 0;

  const rest = (): void => {
    asking?.stop();
    asking = undefined;
    knocking?.stop();
    knocking = undefined;
    if (renewing !== undefined) clearTimeout(renewing);
    renewing = undefined;
  };

  /** One knock, given its time and no more. Out of time is "not now". */
  const knockOnce = (): Promise<Claimed> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tooLong = new Promise<Claimed>((resolve) => {
      timer = setTimeout(() => resolve('try_later'), KNOCK_TIMEOUT_MS);
    });
    return Promise.race([deps.claim(), tooLong]).finally(() => clearTimeout(timer));
  };

  /**
   * The token is gone: nothing more is asked with it. Knock — at once, and
   * then every KNOCK_EVERY_MS — until the app opens the way again.
   *
   * At once matters. Each time the app comes on screen it opens the way,
   * which ends the session this service had; the service learns of it at
   * its next question, at most FAMILY_TV_WAITING_EVERY_MS later, and the
   * way is open for ninety seconds from the opening.
   */
  const knock = (): void => {
    rest();
    serving += 1;
    if (stopped) return;
    knocking = repeat({
      ask: knockOnce,
      everyMs: KNOCK_EVERY_MS,
      onAnswer: (claimed) => {
        // No longer connected at all: there is nothing to wait for.
        if (claimed === 'not_paired') return 'stop';
        if (claimed === 'no_way' || claimed === 'try_later') return undefined;
        serve(claimed.token);
        return 'stop';
      },
    });
  };

  const serve = (token: DeviceToken): void => {
    rest();
    if (stopped) return;
    const mine = ++serving;
    const current = (): boolean => !stopped && serving === mine && asking !== undefined;
    const client = deps.clientFor(token);

    asking = repeat({
      ask: () => client.waiting(),
      everyMs: FAMILY_TV_WAITING_EVERY_MS,
      onAnswer: (answer) => {
        if (answer.kind === 'signedOut') {
          knock();
          return 'stop';
        }
        if (answer.kind !== 'waiting') return undefined;
        for (const one of answer.waiting) {
          if (deps.said.has(one.id)) continue;
          deps.said.add(one.id);
          const toast = waitingToast(one);
          if (toast) deps.announce(toast);
        }
        return undefined;
      },
    });

    // The television's own token is good as proof even after it has run out; only a narrow one has to be kept alive.
    if (!isNarrowToken(token)) return;
    const renewIn = (ms: number): void => {
      renewing = setTimeout(() => {
        renewing = undefined;
        void client.renewNow().then(
          (renewed) => {
            if (!current()) return;
            if (renewed === 'signedOut') knock();
            else renewIn(renewed === 'renewed' ? NARROW_RENEW_AFTER_MS : RENEW_RETRY_MS);
          },
          () => {
            if (current()) renewIn(RENEW_RETRY_MS);
          },
        );
      }, ms);
    };
    renewIn(renewAfterMs(token, Date.now()));
  };

  if (first) serve(first);
  else knock();

  return {
    stop(): void {
      stopped = true;
      rest();
    },
  };
}
