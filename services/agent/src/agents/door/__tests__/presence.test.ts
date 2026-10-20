import { describe, it, expect } from 'vitest';
import type { VisitorMatch } from '@wick/contracts';
import { buildDoorEventItem, buildPresenceItem } from '../presence.js';

const maria: VisitorMatch = {
  personId: 'maria',
  name: 'Maria',
  basis: 'schedule',
  expectedToday: true,
  confidence: 0.5,
};

describe('buildPresenceItem', () => {
  it('keys the item under the household, EVT# timeline', () => {
    const item = buildPresenceItem('hh-1', maria, 1789455093305, 'evt-id-1');
    expect(item.pk).toEqual({ S: 'HH#hh-1' });
  });

  it('encodes the timestamp into the sort key exactly like route.mjs\'s EVT# rows — 15-digit zero-padded ms', () => {
    const item = buildPresenceItem('hh-1', maria, 1789455093305, 'evt-id-1');
    expect(item.sk).toEqual({ S: 'EVT#001789455093305#evt-id-1' });
  });

  it('writes no separate "at" attribute — get_today.ts and did_visitor_come.ts both parse it back out of the sort key', () => {
    const item = buildPresenceItem('hh-1', maria, 1789455093305, 'evt-id-1');
    expect(item.at).toBeUndefined();
  });

  it('carries type=presence, personId and personName — the exact shape did_visitor_come.ts and get_today.ts both read', () => {
    const item = buildPresenceItem('hh-1', maria, 1789455093305, 'evt-id-1');
    expect(item.type).toEqual({ S: 'presence' });
    expect(item.personId).toEqual({ S: 'maria' });
    expect(item.personName).toEqual({ S: 'Maria' });
  });
});

describe('buildDoorEventItem', () => {
  it('keys and timestamps the same way as buildPresenceItem — one EVT# timeline, one encoding', () => {
    const item = buildDoorEventItem('hh-1', 1789455093305, 'evt-id-2');
    expect(item.pk).toEqual({ S: 'HH#hh-1' });
    expect(item.sk).toEqual({ S: 'EVT#001789455093305#evt-id-2' });
  });

  it('carries type=door and nothing else — the generic "someone was at the door" marker get_today.ts already reads', () => {
    const item = buildDoorEventItem('hh-1', 1789455093305, 'evt-id-2');
    expect(item.type).toEqual({ S: 'door' });
    expect(item.personId).toBeUndefined();
    expect(item.personName).toBeUndefined();
    expect(item.simulated).toBeUndefined();
    expect(item.motion).toBeUndefined();
  });

  it('marks a person seen who did not ring, so nothing counts them as a caller', () => {
    expect(buildDoorEventItem('hh-1', 1789455093305, 'evt-id-2', { motion: true }).motion).toEqual({ BOOL: true });
  });
});

describe('a demo home’s stand-in doorbell writes rows marked simulated (AGENTS.md, Data rules)', () => {
  it('marks the door event', () => {
    expect(buildDoorEventItem('hh-demo', 1789455093305, 'evt-id-3', { simulated: true }).simulated).toEqual({ BOOL: true });
  });

  it('marks the presence', () => {
    const item = buildPresenceItem('hh-demo', maria, 1789455093305, 'evt-id-4', { simulated: true });
    expect(item.simulated).toEqual({ BOOL: true });
    expect(item.type).toEqual({ S: 'presence' });
  });

  it('leaves a real home’s rows unmarked', () => {
    expect(buildPresenceItem('hh-1', maria, 1789455093305, 'evt-id-5').simulated).toBeUndefined();
  });
});
