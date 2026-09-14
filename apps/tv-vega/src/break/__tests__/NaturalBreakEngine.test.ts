/**
 * INV-5 is the claim this suite exists to defend. Referenced in
 * docs/WICK-TECHNICAL.md §12.2 — and worth showing on camera going green.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MAX_CARD_SHOWS, type QueuedCard } from '@wick/contracts';
import { allowsDeferred, classify, selectReleasable } from '../index.js';
import type { BreakState, EngineInput } from '../types.js';

const RUNS = 10_000;

const card = (urgency: 'DOOR' | 'DEFERRED', shownCount = 0, expiresAt?: number): QueuedCard => ({
  id: `c_${Math.random().toString(36).slice(2)}`,
  urgency,
  card: {
    type: 'DAY',
    id: 'x',
    householdId: 'hh',
    correlationId: 'corr',
    createdAt: 0,
    actions: [],
    greeting: 'Hello',
    items: [],
  },
  queuedAt: 0,
  shownCount,
  ...(expiresAt === undefined ? {} : { expiresAt }),
});

describe('classify', () => {
  it('is IN_SCENE mid-programme', () => {
    const input: EngineInput = {
      appForeground: true,
      foregroundForMs: 600_000,
      playback: { state: 'PLAYING', positionMs: 100_000, durationMs: 1_400_000, creditsPositionMs: 1_320_000 },
      now: 0,
    };
    expect(classify(input)).toBe('IN_SCENE');
  });

  it('is NEAR_BREAK inside the credits window', () => {
    expect(
      classify({
        appForeground: true,
        playback: { state: 'PLAYING', positionMs: 1_300_000, durationMs: 1_400_000, creditsPositionMs: 1_320_000 },
        now: 0,
      }),
    ).toBe('NEAR_BREAK');
  });

  it('is AT_BREAK at the credits marker', () => {
    expect(
      classify({
        appForeground: true,
        playback: { state: 'PLAYING', positionMs: 1_320_000, durationMs: 1_400_000, creditsPositionMs: 1_320_000 },
        now: 0,
      }),
    ).toBe('AT_BREAK');
  });

  it('treats a long pause as a break, a short one as not', () => {
    const base = { state: 'PAUSED' as const, positionMs: 100, durationMs: 1000 };
    expect(classify({ appForeground: true, playback: base, pausedForMs: 9_000, now: 0 })).toBe('AT_BREAK');
    expect(classify({ appForeground: true, playback: base, pausedForMs: 1_000, now: 0 })).toBe('IN_SCENE');
  });

  it('is TV_SETTLED once the resident has been sitting with it', () => {
    expect(classify({ appForeground: true, foregroundForMs: 25_000, now: 0 })).toBe('TV_SETTLED');
    expect(classify({ appForeground: true, foregroundForMs: 3_000, now: 0 })).toBe('IDLE');
  });

  it('is IDLE when backgrounded, whatever the player says', () => {
    expect(
      classify({
        appForeground: false,
        foregroundForMs: 999_999,
        playback: { state: 'PLAYING', positionMs: 0, durationMs: 100, creditsPositionMs: 0 },
        now: 0,
      }),
    ).toBe('IDLE');
  });
});

describe('selectReleasable', () => {
  const ALL_STATES: BreakState[] = ['IN_SCENE', 'NEAR_BREAK', 'AT_BREAK', 'TV_SETTLED', 'IDLE'];

  it('INV-5: a DEFERRED card is never released outside AT_BREAK or TV_SETTLED', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATES),
        fc.integer({ min: 0, max: MAX_CARD_SHOWS - 1 }),
        (state, shown) => {
          const { release } = selectReleasable([card('DEFERRED', shown)], state, 0);
          if (!allowsDeferred(state)) expect(release).toHaveLength(0);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('a DOOR card is released in every state', () => {
    for (const state of ALL_STATES) {
      const { release } = selectReleasable([card('DOOR')], state, 0);
      expect(release).toHaveLength(1);
    }
  });

  it('retires a card that has already been shown twice — never a third time', () => {
    for (const state of ALL_STATES) {
      const { release, retire } = selectReleasable([card('DEFERRED', MAX_CARD_SHOWS)], state, 0);
      expect(release).toHaveLength(0);
      expect(retire).toHaveLength(1);
    }
  });

  it('never loses a card: release + hold + retire always partitions the queue', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            urgency: fc.constantFrom('DOOR' as const, 'DEFERRED' as const),
            shownCount: fc.integer({ min: 0, max: 3 }),
          }),
          { maxLength: 20 },
        ),
        fc.constantFrom(...ALL_STATES),
        (specs, state) => {
          const queue = specs.map((s) => card(s.urgency, s.shownCount));
          const r = selectReleasable(queue, state, 0);
          expect(r.release.length + r.hold.length + r.retire.length).toBe(queue.length);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('DEFERRED cards never expire — Principle 9, no time limits', () => {
    const far = Number.MAX_SAFE_INTEGER;
    const { release, hold } = selectReleasable([card('DEFERRED')], 'AT_BREAK', far);
    expect(release).toHaveLength(1);
    expect(hold).toHaveLength(0);
  });
});
