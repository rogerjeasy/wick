/**
 * INV-5 is the claim this suite exists to defend. Referenced in
 * docs/WICK-TECHNICAL.md §12.2 — and worth showing on camera going green.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DOOR_CARD_TTL_MS, MAX_CARD_SHOWS, type QueuedCard } from '@wick/contracts';
import { allowsDeferred, classify, holdsProgramme, selectReleasable } from '../index.js';
import { CALM_POINT_WINDOW_MS, type BreakState, type EngineInput } from '../types.js';

const RUNS = 10_000;

const card = (urgency: 'DOOR' | 'DEFERRED', shownCount = 0, expiresAt?: number): QueuedCard => ({
  id: `c_${Math.random().toString(36).slice(2)}`,
  urgency,
  card: {
    type: 'MESSAGE',
    id: 'x',
    householdId: 'hh',
    correlationId: 'corr',
    createdAt: 0,
    actions: [],
    fromName: 'Sarah',
    suggestedReplies: [],
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

describe('classify — calm points inside a programme', () => {
  const playing = (positionMs: number, state: 'PLAYING' | 'PAUSED' | 'BUFFERING' = 'PLAYING', pausedForMs?: number): EngineInput => ({
    appForeground: true,
    foregroundForMs: 600_000,
    playback: { state, positionMs, durationMs: 900_000, creditsPositionMs: 750_000, calmPointsMs: [180_000, 420_000] },
    ...(pausedForMs === undefined ? {} : { pausedForMs }),
    now: 0,
  });

  it('is AT_BREAK from a calm point for a few seconds, and IN_SCENE on either side of that', () => {
    expect(classify(playing(179_999))).toBe('IN_SCENE');
    expect(classify(playing(180_000))).toBe('AT_BREAK');
    expect(classify(playing(180_000 + CALM_POINT_WINDOW_MS - 1))).toBe('AT_BREAK');
    expect(classify(playing(180_000 + CALM_POINT_WINDOW_MS))).toBe('IN_SCENE');
    expect(classify(playing(420_500))).toBe('AT_BREAK');
  });

  it('is a break at once when the programme is held on a calm point — a card must not vanish because the film stopped for it', () => {
    expect(classify(playing(181_000, 'PAUSED', 0))).toBe('AT_BREAK');
    expect(classify(playing(181_000, 'BUFFERING'))).toBe('AT_BREAK');
    // Away from a calm point a short pause is still just a pause.
    expect(classify(playing(300_000, 'PAUSED', 1_000))).toBe('IN_SCENE');
  });

  it('changes nothing for a programme that has none', () => {
    const none: EngineInput = { appForeground: true, playback: { state: 'PLAYING', positionMs: 180_500, durationMs: 900_000, creditsPositionMs: 750_000 }, now: 0 };

    expect(classify(none)).toBe('IN_SCENE');
  });

  it('INV-5, with calm points: while a programme plays before its credits, a deferred card may show only inside a calm window', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 700_000 }), { maxLength: 6 }),
        fc.integer({ min: 0, max: 749_999 - 30_000 }),
        (calmPointsMs, positionMs) => {
          const state = classify({
            appForeground: true,
            foregroundForMs: 600_000,
            playback: { state: 'PLAYING', positionMs, durationMs: 900_000, creditsPositionMs: 750_000, calmPointsMs },
            now: 0,
          });
          const inWindow = calmPointsMs.some((at) => positionMs >= at && positionMs < at + CALM_POINT_WINDOW_MS);
          return allowsDeferred(state) === inWindow;
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('holdsProgramme — when the film waits for a card', () => {
  const at = (positionMs: number, state: 'PLAYING' | 'PAUSED' = 'PLAYING') => ({ state, positionMs, durationMs: 900_000, creditsPositionMs: 750_000 });

  it('holds for a card that waited for a calm point: reading a note while the story goes on is the interruption', () => {
    expect(holdsProgramme(card('DEFERRED'), at(181_000))).toBe(true);
  });

  it('never holds for the door: someone at the door does not stop the programme', () => {
    expect(holdsProgramme(card('DOOR'), at(181_000))).toBe(false);
  });

  it('does not hold at the credits: the story is over, and nothing is missed', () => {
    expect(holdsProgramme(card('DEFERRED'), at(750_000))).toBe(false);
    expect(holdsProgramme(card('DEFERRED'), at(800_000))).toBe(false);
  });

  it('holds nothing when there is no card, or no programme', () => {
    expect(holdsProgramme(undefined, at(181_000))).toBe(false);
    expect(holdsProgramme(card('DEFERRED'), undefined)).toBe(false);
    expect(holdsProgramme(card('DEFERRED'), { ...at(181_000), state: 'STOPPED' as const })).toBe(false);
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

  it('a DOOR card with no expiresAt still retires DOOR_CARD_TTL_MS after it was queued', () => {
    // Cards sent before the Door agent set expiresAt carry none. Reconcile
    // replays them on every connect while the device can't persist its
    // high-water mark (FL-013) — without this, a doorbell from last week
    // would be announced as someone at the door right now.
    const legacy = card('DOOR'); // queuedAt: 0, no expiresAt
    expect(selectReleasable([legacy], 'IN_SCENE', DOOR_CARD_TTL_MS - 1).release).toHaveLength(1);
    expect(selectReleasable([legacy], 'IN_SCENE', DOOR_CARD_TTL_MS).retire).toHaveLength(1);
  });

  it("a DOOR card's own expiresAt wins over the queuedAt fallback", () => {
    const short = card('DOOR', 0, 10_000);
    expect(selectReleasable([short], 'IN_SCENE', 10_000).retire).toHaveLength(1);
  });

  it('DEFERRED cards never expire — Principle 9, no time limits', () => {
    const far = Number.MAX_SAFE_INTEGER;
    const { release, hold } = selectReleasable([card('DEFERRED')], 'AT_BREAK', far);
    expect(release).toHaveLength(1);
    expect(hold).toHaveLength(0);
  });
});
