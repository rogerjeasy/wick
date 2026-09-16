import { describe, expect, it } from 'vitest';
import {
  generatePairingCode,
  isExpired,
  PAIRING_CODE_TTL_MS,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../pairing-code.mjs';

describe('generatePairingCode', () => {
  it('always returns a 6-digit string', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});

describe('isExpired', () => {
  it('is expired when there is no record', () => {
    expect(isExpired(undefined)).toBe(true);
  });

  it('is expired once expiresAt has passed', () => {
    const now = 1_000_000;
    expect(isExpired({ expiresAt: now - 1 }, now)).toBe(true);
    expect(isExpired({ expiresAt: now + 1 }, now)).toBe(false);
  });

  it('PAIRING_CODE_TTL_MS is 15 minutes, per §4.2', () => {
    expect(PAIRING_CODE_TTL_MS).toBe(15 * 60 * 1000);
  });
});
