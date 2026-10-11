import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deviceBindingKey,
  isServed,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../device-standing.mjs';

describe('isServed', () => {
  it('serves a paired television', () => {
    expect(isServed({ pk: { S: 'HH#hh_1' }, sk: { S: 'DEV#tv-1' } })).toBe(true);
  });

  it('serves one whose revocation was lifted', () => {
    expect(isServed({ denylisted: { BOOL: false } })).toBe(true);
  });

  it('refuses a revoked television', () => {
    expect(isServed({ denylisted: { BOOL: true } })).toBe(false);
  });

  it('refuses a television that is no longer paired at all', () => {
    expect(isServed(undefined)).toBe(false);
  });
});

describe('deviceBindingKey', () => {
  it("is the television's item under its household — where revocation is written", () => {
    expect(deviceBindingKey('hh_1', 'tv-1')).toEqual({ pk: { S: 'HH#hh_1' }, sk: { S: 'DEV#tv-1' } });
  });
});

describe('every way a television is served checks its standing', () => {
  const source = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

  it('a new connection', () => {
    expect(source('connect.mjs')).toMatch(/isServed\(/);
  });

  it('every message on a connection it already holds, before anything is read or written for it', () => {
    const route = source('route.mjs');
    const gate = route.indexOf('isServed(');
    const firstUse = route.indexOf("deviceEvent.t === 'app_lifecycle'");

    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(firstUse);
  });
});
