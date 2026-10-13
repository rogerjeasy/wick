import { describe, expect, it } from 'vitest';
import {
  PROGRAMMES,
  WATCH_ANSWERS,
  WATCH_CARD_KINDS,
  WATCH_OPENS_BEFORE_MS,
  WATCH_OPEN_FOR_MS,
  isWatchAnswer,
  programmeById,
  watchCardId,
  watchCardOf,
  watchWindow,
} from '../index.js';

describe('PROGRAMMES', () => {
  it('is the three open films, each found by its id', () => {
    expect(PROGRAMMES.map((p) => p.id)).toEqual(['big-buck-bunny', 'sintel', 'tears-of-steel']);
    expect(programmeById('sintel')?.title).toBe('Sintel');
    expect(programmeById('nope')).toBeUndefined();
  });
});

describe('watchCardId / watchCardOf', () => {
  it('names each of a session’s cards — the four in their order, and the one that says it is called off — and reads the session back from the name', () => {
    for (const kind of WATCH_CARD_KINDS) {
      const id = watchCardId(kind, 'a1b2-c3');
      expect(watchCardOf(id)).toEqual({ kind, sessionId: 'a1b2-c3' });
    }
    expect(WATCH_CARD_KINDS).toEqual(['invite', 'ready', 'question', 'answer', 'cancelled']);
    expect(new Set(WATCH_CARD_KINDS.map((kind) => watchCardId(kind, 's'))).size).toBe(5);
  });

  it('is nothing for any other card', () => {
    for (const id of ['note-123', 'week-2026-W41', 'door-abc', 'circle-u_1', 'watch-', 'watch-invite-', 'watch-nope-abc', 'watch-invite-a b']) {
      expect(watchCardOf(id)).toBeUndefined();
    }
  });
});

describe('isWatchAnswer', () => {
  it('knows the three answers and nothing a caller wrote', () => {
    expect(Object.keys(WATCH_ANSWERS)).toHaveLength(3);
    for (const key of Object.keys(WATCH_ANSWERS)) expect(isWatchAnswer(key)).toBe(true);
    for (const key of ['I loved it.', 'toString', '', undefined, 3]) expect(isWatchAnswer(key)).toBe(false);
  });
});

describe('watchWindow', () => {
  it('opens a little before the time asked for and stays open long enough for the film', () => {
    const startsAt = 1_790_900_000_000;
    expect(watchWindow(startsAt)).toEqual({ opensAt: startsAt - WATCH_OPENS_BEFORE_MS, closesAt: startsAt + WATCH_OPEN_FOR_MS });
    // The longest film is under fifteen minutes; someone late by an hour can still watch all of it.
    const longest = Math.max(...PROGRAMMES.map((p) => p.durationMs));
    expect(WATCH_OPEN_FOR_MS).toBeGreaterThan(longest + 60 * 60_000);
  });
});
