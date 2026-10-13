/**
 * How long the token a television is using still has. Pure.
 *
 * A refreshed token lasts an hour (edge-device pairing-code.mjs
 * REFRESH_TOKEN_TTL_SEC) — every token the Vega simulator ever holds, since
 * it keeps none on disk — and the MQTT session ends when the token does
 * (iot-policy.mjs `sessionSeconds`). The channel then reconnects with the
 * token it was given, which has run out, and is refused until Wick is
 * launched again: after an hour on screen her television silently stopped
 * receiving cards. So a television that is still connected takes a fresh
 * token in good time (pairing/standing.ts), and this says when that is.
 *
 * The end a token names (`expiresAt`) is by the pairing service's clock,
 * and a television's own can be hours out — 6.9 hours, on the Vega
 * simulator. By such a clock a token an hour long ran out before it was
 * handed over, or has hours more than it has. So a token this television
 * SAW handed over is measured by time gone by since then, against the life
 * the token itself states (`exp − iat`, both the service's). Only a token
 * nobody saw handed over — read from the disk, where a disk keeps one — is
 * taken at the end it names: nothing better is known of it, and it is what
 * the launch already goes by (PairingFlow.loadToken).
 */
import type { DeviceToken } from '@wick/contracts';

/** The token in use, and — where this television saw the pairing service hand it over — when that was, by its own clock. */
export interface HeldToken {
  readonly token: DeviceToken;
  readonly since?: number;
}

/**
 * A token with this little left is "about to run out". The television asks
 * once a minute while it is on screen (standing.ts), so the fresh one has
 * five tries to arrive in before the old one ends.
 */
export const TOKEN_MARGIN_MS = 5 * 60_000;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** base64url (or base64) to one character a byte. Enough for JSON whose numbers are all that is read; no `atob` is counted on. */
function bytesOf(encoded: string): string {
  let out = '';
  let held = 0;
  let bits = 0;
  for (const letter of encoded) {
    const at = BASE64.indexOf(letter);
    const six = at >= 0 ? at : letter === '-' || letter === '+' ? 62 : letter === '_' || letter === '/' ? 63 : -1;
    if (six < 0) continue;
    held = ((held << 6) | six) & 0xffff;
    bits += 6;
    if (bits < 8) continue;
    bits -= 8;
    out += String.fromCharCode((held >> bits) & 0xff);
  }
  return out;
}

/**
 * How long the pairing service made this token good for, from the token
 * itself — or undefined when it does not say. Nothing is verified here and
 * nothing is trusted: the edge decides what a token opens.
 */
export function lifeMsOf(token: DeviceToken): number | undefined {
  try {
    const claims = JSON.parse(bytesOf(token.jwt.split('.')[1] ?? '')) as { readonly iat?: unknown; readonly exp?: unknown } | null;
    const { iat, exp } = claims ?? {};
    if (typeof iat !== 'number' || typeof exp !== 'number' || !(exp > iat)) return undefined;
    return (exp - iat) * 1000;
  } catch {
    return undefined;
  }
}

/** How long the token in use still has. Less than nothing once it has run out. */
export function leftMs(held: HeldToken, now: number): number {
  const life = held.since === undefined ? undefined : lifeMsOf(held.token);
  if (held.since !== undefined && life !== undefined) return held.since + life - now;
  return held.token.expiresAt - now;
}

/** Run out, or about to. */
export function nearItsEnd(held: HeldToken, now: number): boolean {
  return leftMs(held, now) <= TOKEN_MARGIN_MS;
}
