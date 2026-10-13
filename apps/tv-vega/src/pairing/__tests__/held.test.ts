import { describe, expect, it } from 'vitest';
import type { DeviceToken } from '@wick/contracts';
import { TOKEN_MARGIN_MS, leftMs, lifeMsOf, nearItsEnd } from '../held.js';

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A token as the pairing service mints one (edge-device jwt.mjs): `life` long from `at`, both by the service's clock. */
function minted(at: number, life = HOUR): DeviceToken {
  const iat = Math.floor(at / 1000);
  const jwt = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ deviceId: 'd1', householdId: 'h1', iat, exp: iat + life / 1000 })}.signature`;
  return { jwt, deviceId: 'd1', householdId: 'h1', expiresAt: at + life };
}

describe('lifeMsOf — how long the pairing service made a token good for', () => {
  it('an hour for a refreshed token, thirty days for one from a pairing: read from the token itself', () => {
    expect(lifeMsOf(minted(T0))).toBe(HOUR);
    expect(lifeMsOf(minted(T0, 30 * DAY))).toBe(30 * DAY);
  });

  it('does not depend on what the television’s clock says', () => {
    // Minted long ago, or — to a television whose clock is behind — in the future.
    expect(lifeMsOf(minted(T0 - 400 * DAY))).toBe(HOUR);
    expect(lifeMsOf(minted(T0 + 400 * DAY))).toBe(HOUR);
  });

  it('nothing known for a token that cannot be read, or that does not say when it was made', () => {
    expect(lifeMsOf({ jwt: 'j', deviceId: 'd1', householdId: 'h1', expiresAt: T0 })).toBeUndefined();
    expect(lifeMsOf({ jwt: 'a.b.c', deviceId: 'd1', householdId: 'h1', expiresAt: T0 })).toBeUndefined();
    expect(lifeMsOf({ jwt: `x.${part({ exp: 5 })}.y`, deviceId: 'd1', householdId: 'h1', expiresAt: T0 })).toBeUndefined();
    expect(lifeMsOf({ jwt: `x.${part({ iat: 9, exp: 5 })}.y`, deviceId: 'd1', householdId: 'h1', expiresAt: T0 })).toBeUndefined();
    expect(lifeMsOf({ jwt: `x.${part('not an object')}.y`, deviceId: 'd1', householdId: 'h1', expiresAt: T0 })).toBeUndefined();
  });

  it('reads a token whose other claims are not plain letters', () => {
    const jwt = `${part({ alg: 'RS256' })}.${part({ householdId: 'hh_Zoë–?>~', iat: 100, exp: 3700 })}.s`;
    expect(lifeMsOf({ jwt, deviceId: 'd1', householdId: 'h1', expiresAt: T0 })).toBe(HOUR);
  });
});

describe('leftMs — how long the token in use still has', () => {
  it('a token handed over while this television watched: its life, less the time since — whatever the clock says', () => {
    const token = minted(T0);
    expect(leftMs({ token, since: T0 }, T0)).toBe(HOUR);
    expect(leftMs({ token, since: T0 }, T0 + 50 * MINUTE)).toBe(10 * MINUTE);
    expect(leftMs({ token, since: T0 }, T0 + 61 * MINUTE)).toBe(-MINUTE);
  });

  // Seen on the Vega simulator: its clock was 6.9 hours out. By that clock
  // every token it is handed ran out hours ago, or has hours more than it has.
  it('a television whose clock is hours fast or hours slow counts the same hour', () => {
    const fast = T0 + 6.9 * HOUR;
    const slow = T0 - 6.9 * HOUR;
    for (const clock of [fast, slow]) {
      const held = { token: minted(T0), since: clock };
      expect(leftMs(held, clock)).toBe(HOUR);
      expect(leftMs(held, clock + 56 * MINUTE)).toBe(4 * MINUTE);
    }
  });

  it('a token read from the disk: nobody saw it handed over, so by the end it names', () => {
    const token = minted(T0 - 10 * DAY, 30 * DAY);
    expect(leftMs({ token }, T0)).toBe(20 * DAY);
    expect(leftMs({ token }, T0 + 20 * DAY + MINUTE)).toBe(-MINUTE);
  });

  it('a token that cannot be read: by the end it names, handed over or not', () => {
    const token: DeviceToken = { jwt: 'j', deviceId: 'd1', householdId: 'h1', expiresAt: T0 + HOUR };
    expect(leftMs({ token, since: T0 }, T0 + 20 * MINUTE)).toBe(40 * MINUTE);
  });
});

describe('nearItsEnd — when a fresh token is taken in its place', () => {
  const held = { token: minted(T0), since: T0 };

  it('five minutes before the end, and from then on', () => {
    expect(TOKEN_MARGIN_MS).toBe(5 * MINUTE);
    expect(nearItsEnd(held, T0 + 55 * MINUTE)).toBe(true);
    expect(nearItsEnd(held, T0 + 59 * MINUTE)).toBe(true);
    expect(nearItsEnd(held, T0 + 3 * HOUR)).toBe(true);
  });

  it('not while it has plenty of life left', () => {
    expect(nearItsEnd(held, T0)).toBe(false);
    expect(nearItsEnd(held, T0 + 30 * MINUTE)).toBe(false);
    expect(nearItsEnd(held, T0 + 55 * MINUTE - 1)).toBe(false);
  });

  it('a thirty-day token mid-life is nowhere near it', () => {
    expect(nearItsEnd({ token: minted(T0 - 15 * DAY, 30 * DAY) }, T0)).toBe(false);
  });
});
