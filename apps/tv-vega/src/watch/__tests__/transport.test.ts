import { describe, expect, it } from 'vitest';
import { TRANSPORT_SHOWN_MS, asksWhereFilmIs, clock, fraction, minutesLeft, transportShown } from '../transport.js';

const base = { paused: false, cardVisible: false, ready: true, askedAt: null, now: 10_000 } as const;

describe('transportShown — the film’s bar', () => {
  it('stays while the film is paused', () => {
    expect(transportShown({ ...base, paused: true })).toBe(true);
  });

  it('comes when she asks, and goes after four seconds of play', () => {
    expect(transportShown({ ...base, askedAt: 10_000 })).toBe(true);
    expect(transportShown({ ...base, askedAt: 10_000 - TRANSPORT_SHOWN_MS + 1 })).toBe(true);
    expect(transportShown({ ...base, askedAt: 10_000 - TRANSPORT_SHOWN_MS })).toBe(false);
    expect(transportShown(base)).toBe(false);
  });

  it('never covers a card, and says nothing about a film that is not ready', () => {
    expect(transportShown({ ...base, paused: true, cardVisible: true })).toBe(false);
    expect(transportShown({ ...base, paused: true, ready: false })).toBe(false);
  });
});

describe('asksWhereFilmIs — ↑ and ↓ over a film', () => {
  it('is ↑ or ↓ going down, by either name, with no card on screen', () => {
    for (const key of ['up', 'down', 'dpad_up', 'dpad_down']) {
      expect(asksWhereFilmIs({ eventType: key, eventKeyAction: 0 }, { cardVisible: false })).toBe(true);
      expect(asksWhereFilmIs({ eventType: key }, { cardVisible: false })).toBe(true);
    }
  });

  it('is not the key coming up, not another key, and not while a card has the remote', () => {
    expect(asksWhereFilmIs({ eventType: 'up', eventKeyAction: 1 }, { cardVisible: false })).toBe(false);
    expect(asksWhereFilmIs({ eventType: 'left', eventKeyAction: 0 }, { cardVisible: false })).toBe(false);
    expect(asksWhereFilmIs({ eventType: 'up', eventKeyAction: 0 }, { cardVisible: true })).toBe(false);
  });
});

describe('the bar’s numbers', () => {
  it('writes a time as minutes and seconds, and hours past the hour', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(89_400)).toBe('1:29');
    expect(clock(596_000)).toBe('9:56');
    expect(clock(3_729_000)).toBe('1:02:09');
    expect(clock(-5)).toBe('0:00');
    expect(clock(Number.NaN)).toBe('0:00');
  });

  it('gives how far the film has got, kept between 0 and 1', () => {
    expect(fraction(30_000, 120_000)).toBe(0.25);
    expect(fraction(200_000, 120_000)).toBe(1);
    expect(fraction(-1, 120_000)).toBe(0);
    expect(fraction(30_000, 0)).toBe(0);
  });

  it('rounds the minutes left up, and says at least one while any film is left', () => {
    expect(minutesLeft(0, 596_000)).toBe(10);
    expect(minutesLeft(590_000, 596_000)).toBe(1);
    expect(minutesLeft(596_000, 596_000)).toBe(0);
    expect(minutesLeft(0, 0)).toBe(0);
  });
});
