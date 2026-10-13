import { describe, expect, it } from 'vitest';
import type { DeviceToken } from '@wick/contracts';
import { televisionMode } from '../mode.js';

const token = (extra: object = {}): DeviceToken => ({ jwt: 'j', deviceId: 'd1', householdId: 'h1', expiresAt: 1, ...extra }) as DeviceToken;

describe('televisionMode — whose television a token makes this', () => {
  it("is the resident's when the token names no kind, exactly as before there were two", () => {
    expect(televisionMode(token())).toBe('resident');
  });

  it("is a family member's own when the token says so", () => {
    expect(televisionMode(token({ kind: 'family' }))).toBe('family');
  });

  it('reads an empty kind as no kind', () => {
    expect(televisionMode(token({ kind: undefined }))).toBe('resident');
    expect(televisionMode(token({ kind: null }))).toBe('resident');
  });

  it("is never the resident's under a kind it does not know: nothing of hers runs on a guess", () => {
    expect(televisionMode(token({ kind: 'neighbour' }))).toBe('family');
    expect(televisionMode(token({ kind: '' }))).toBe('family');
    expect(televisionMode(token({ kind: 7 }))).toBe('family');
  });
});
