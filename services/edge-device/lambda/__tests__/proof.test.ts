import { describe, expect, it } from 'vitest';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { isProof, isUnproven, proofHashOf, proofMatches, refusesUnproven } from '../proof.mjs';

const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';
const HOUR = 3600;

describe('a television’s proof (proof.mjs)', () => {
  it('takes only a long, plain secret as one', () => {
    expect(isProof(SECRET)).toBe(true);
    for (const not of [undefined, null, 42, '', 'short', 'x'.repeat(129), `${SECRET.slice(0, 40)} spaces here`, { secret: SECRET }]) {
      expect(isProof(not)).toBe(false);
    }
  });

  it('keeps a hash the secret cannot be read back from, and matches only the same secret', () => {
    const stored = proofHashOf(SECRET);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(SECRET);
    expect(proofMatches(SECRET, stored)).toBe(true);
    expect(proofMatches(`${SECRET.slice(0, -1)}0`, stored)).toBe(false);
    expect(proofMatches(undefined, stored)).toBe(false);
    // A row that keeps something that is not a hash matches nothing.
    expect(proofMatches(SECRET, SECRET)).toBe(false);
    expect(proofMatches(SECRET, undefined)).toBe(false);
  });

  it('tells a token minted without proof by what it says — or, from before it said, by an hour’s life', () => {
    const lived = (seconds: number, extra: object = {}) => ({ iat: 1000, exp: 1000 + seconds, ...extra });
    expect(isUnproven(lived(HOUR, { proof: 'none' }))).toBe(true);
    expect(isUnproven(lived(HOUR, { proof: 'secret' }))).toBe(false);
    expect(isUnproven(lived(30 * 86400, { proof: 'pairing' }))).toBe(false);
    // Older tokens: a refresh's hour proves nothing, a pairing's thirty days do.
    expect(isUnproven(lived(HOUR))).toBe(true);
    expect(isUnproven(lived(30 * 86400))).toBe(false);
    // A claim it does not know, or no lifetime at all, proves nothing either.
    expect(isUnproven({ proof: 'trust-me' })).toBe(true);
    expect(isUnproven({})).toBe(true);
  });

  it('refuses an unproven token only where the television’s row keeps a proof', () => {
    expect(refusesUnproven({ proofHash: { S: proofHashOf(SECRET) } }, true)).toBe(true);
    expect(refusesUnproven({ proofHash: { S: proofHashOf(SECRET) } }, false)).toBe(false);
    expect(refusesUnproven({}, true)).toBe(false);
    expect(refusesUnproven(undefined, true)).toBe(false);
  });
});
