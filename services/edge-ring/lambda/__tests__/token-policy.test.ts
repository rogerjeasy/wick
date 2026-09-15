import { describe, it, expect } from 'vitest';
import {
  REFRESH_SKEW_MS,
  DEFAULT_EXPIRES_IN_S,
  expiresAt,
  needsRefresh,
  isRefreshable,
  mergeTokens,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../token-policy.mjs';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

describe('expiresAt', () => {
  it('prefers the stamped absolute expiry', () => {
    expect(expiresAt({ expiresAt: NOW + HOUR, obtainedAt: 0, expires_in: 1 }))
      .toBe(NOW + HOUR);
  });

  it('falls back to obtainedAt + expires_in for a record written before stamping', () => {
    expect(expiresAt({ obtainedAt: NOW, expires_in: 14400 })).toBe(NOW + 4 * HOUR);
  });

  it('assumes Ring\'s documented lifetime when expires_in is missing', () => {
    expect(expiresAt({ obtainedAt: NOW })).toBe(NOW + DEFAULT_EXPIRES_IN_S * 1000);
  });

  it('treats a missing record as long expired', () => {
    expect(expiresAt(null)).toBe(0);
  });
});

describe('needsRefresh', () => {
  it('is false for a token with hours of life left', () => {
    expect(needsRefresh({ access_token: 'a', expiresAt: NOW + 3 * HOUR }, NOW)).toBe(false);
  });

  it('is true once the token is inside the skew window', () => {
    expect(needsRefresh({ access_token: 'a', expiresAt: NOW + REFRESH_SKEW_MS - 1 }, NOW))
      .toBe(true);
  });

  it('is true for an already-expired token', () => {
    expect(needsRefresh({ access_token: 'a', expiresAt: NOW - 1 }, NOW)).toBe(true);
  });

  it('is true when there is no access token at all', () => {
    expect(needsRefresh({ refresh_token: 'r' }, NOW)).toBe(true);
    expect(needsRefresh(null, NOW)).toBe(true);
  });
});

describe('isRefreshable', () => {
  it('distinguishes "needs a refresh" from "needs a human"', () => {
    expect(isRefreshable({ refresh_token: 'r' })).toBe(true);
    expect(isRefreshable({ access_token: 'a' })).toBe(false);
    expect(isRefreshable(null)).toBe(false);
  });
});

describe('mergeTokens', () => {
  it('keeps the previous refresh token when Ring does not resend one', () => {
    const merged = mergeTokens(
      { access_token: 'old', refresh_token: 'keep-me' },
      { access_token: 'new', expires_in: 14400 },
      NOW,
    );

    expect(merged.access_token).toBe('new');
    expect(merged.refresh_token).toBe('keep-me');
  });

  it('takes the rotated refresh token when Ring does send one', () => {
    const merged = mergeTokens(
      { refresh_token: 'old' },
      { access_token: 'new', refresh_token: 'rotated' },
      NOW,
    );

    expect(merged.refresh_token).toBe('rotated');
  });

  it('stamps an absolute expiry so no later reader repeats the arithmetic', () => {
    const merged = mergeTokens(null, { access_token: 'a', expires_in: 14400 }, NOW);

    expect(merged.obtainedAt).toBe(NOW);
    expect(merged.expiresAt).toBe(NOW + 4 * HOUR);
    expect(needsRefresh(merged, NOW)).toBe(false);
  });

  it('carries the account identifier forward across a refresh', () => {
    const merged = mergeTokens(
      { accountId: 'acct-1', refresh_token: 'r' },
      { access_token: 'new' },
      NOW,
    );

    expect(merged.accountId).toBe('acct-1');
  });

  it('never leaves a refreshed record looking stale', () => {
    const merged = mergeTokens({ refresh_token: 'r' }, { access_token: 'a' }, NOW);
    expect(needsRefresh(merged, NOW)).toBe(false);
  });
});
