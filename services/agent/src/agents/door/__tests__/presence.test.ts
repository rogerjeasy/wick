import { describe, it, expect } from 'vitest';
import type { VisitorMatch } from '@wick/contracts';
import { buildPresenceItem } from '../presence.js';

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
