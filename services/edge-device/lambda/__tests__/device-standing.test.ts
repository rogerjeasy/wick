import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deviceBindingKey,
  isResidentsToken,
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
    // One handler for both channels, so one gate covers both.
    const handler = source('device-event.mjs');
    const gate = handler.indexOf('isServed(');
    const firstUse = handler.indexOf("deviceEvent.t === 'app_lifecycle'");

    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(firstUse);
  });

  it('whichever channel the message came by: both hand it to that one handler, and neither handles it itself', () => {
    for (const entry of ['route.mjs', 'iot-events.mjs']) {
      expect(source(entry), entry).toMatch(/handleDeviceEvent\(/);
      expect(source(entry), entry).not.toMatch(/deviceEvent\.t ===/);
    }
  });

  it('a new MQTT connection, and again each time IoT Core asks', () => {
    expect(source('iot-authorize.mjs')).toMatch(/isServed\(/);
  });

  it('never takes the television or its household from what the television sent over MQTT', () => {
    const events = source('iot-events.mjs');

    // The id is the one in the topic, which only that television may publish to.
    expect(events).toMatch(/event\?\.deviceId/);
    expect(events).not.toMatch(/deviceEvent\.(deviceId|householdId)/);
    expect(events).toMatch(/householdOfDevice\(/);
  });
});

describe('isResidentsToken — whose channel this is', () => {
  it('is a token with a television and a home, and no kind', () => {
    expect(isResidentsToken({ deviceId: 'tv-1', householdId: 'hh_1' })).toBe(true);
  });

  it('is never a family member’s own television, whatever rows the device may have', () => {
    expect(isResidentsToken({ deviceId: 'tv-1', householdId: 'hh_1', kind: 'family', userId: 'u_sarah' })).toBe(false);
  });

  it('is never a kind it has not heard of, nor a token with something missing', () => {
    for (const claims of [{ deviceId: 'tv-1', householdId: 'hh_1', kind: 'resident' }, { deviceId: 'tv-1', householdId: 'hh_1', kind: '' }, { deviceId: 'tv-1' }, { householdId: 'hh_1' }, null, undefined]) {
      expect(isResidentsToken(claims)).toBe(false);
    }
  });

  it('is asked wherever a television comes onto the resident’s channel', () => {
    for (const file of ['connect.mjs', 'iot-authorize.mjs']) {
      expect(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).toMatch(/isResidentsToken\(claims\)/);
    }
  });
});

