import { describe, expect, it } from 'vitest';
import { MANTEL_URL_TTL_SEC, type MantelItem, type QueuedCard } from '@wick/contracts';
import type { Mantel } from '../../headless/QueueStore.js';
import {
  MANTEL_ASK_AGAIN_MS,
  MANTEL_FRESH_FOR_MS,
  VIEWER_START,
  caption,
  inView,
  isFresh,
  mantelToShow,
  offersMantel,
  overMantel,
  pictureRefresher,
  shouldAsk,
  viewer,
  type Viewer,
  type ViewerEvent,
} from '../mantel.js';

const NOW = 1_800_000_000_000;
const item = (photoId: string, fromName = 'Sarah'): MantelItem => ({ photoId, fromName, keptAt: 5, url: `https://pictures.example/${photoId}.jpg` });
const mantel = (ids: readonly string[], receivedAt = NOW): Mantel => ({ items: ids.map((id) => item(id)), receivedAt });

/** Runs events through the viewer, and says what it asked for on the way. */
function run(events: readonly ViewerEvent[], from: Viewer = VIEWER_START) {
  let state = from;
  const effects: unknown[] = [];
  for (const event of events) {
    const next = viewer(state, event);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}
const opened = (ids: readonly string[]) => run([{ t: 'mantel', mantel: mantel(ids) }]).state;

describe('offersMantel — the pill on the home screen', () => {
  it('is there when at least one thing is on her mantelpiece, and not otherwise', () => {
    expect(offersMantel({ mantel: 1 })).toBe(true);
    expect(offersMantel({ mantel: 12 })).toBe(true);
    expect(offersMantel({})).toBe(false);
    expect(offersMantel({ light: 'on' })).toBe(false);
    expect(offersMantel({ mantel: 0 })).toBe(false);
  });
});

describe('how long an answer is good for', () => {
  it('is asked for again well before its addresses stop answering: about fifty minutes of the hour', () => {
    expect(MANTEL_FRESH_FOR_MS).toBe(50 * 60_000);
    expect(MANTEL_FRESH_FOR_MS).toBeLessThan(MANTEL_URL_TTL_SEC * 1000);
  });

  it('is fresh until then', () => {
    expect(isFresh(mantel(['p1']), NOW)).toBe(true);
    expect(isFresh(mantel(['p1']), NOW + MANTEL_FRESH_FOR_MS - 1)).toBe(true);
    expect(isFresh(mantel(['p1']), NOW + MANTEL_FRESH_FOR_MS)).toBe(false);
    expect(isFresh(undefined, NOW)).toBe(false);
  });
});

describe('shouldAsk — asking the server for the mantelpiece again', () => {
  it('asks when nothing is known, or what is known is old', () => {
    expect(shouldAsk({ mantel: undefined, askedAt: null, now: NOW })).toBe(true);
    expect(shouldAsk({ mantel: mantel(['p1']), askedAt: null, now: NOW + MANTEL_FRESH_FOR_MS })).toBe(true);
  });

  it('does not ask while what it has is fresh', () => {
    expect(shouldAsk({ mantel: mantel(['p1']), askedAt: null, now: NOW + 60_000 })).toBe(false);
  });

  it('does not ask again within a minute of asking: an answer is on its way, or the server is not there', () => {
    expect(shouldAsk({ mantel: undefined, askedAt: NOW, now: NOW + 1_000 })).toBe(false);
    expect(shouldAsk({ mantel: undefined, askedAt: NOW, now: NOW + MANTEL_ASK_AGAIN_MS - 1 })).toBe(false);
    expect(shouldAsk({ mantel: undefined, askedAt: NOW, now: NOW + MANTEL_ASK_AGAIN_MS })).toBe(true);
  });
});

describe('mantelToShow — what the screen has when she opens it', () => {
  it('waits for the answer to this opening when it has nothing', () => {
    expect(mantelToShow(undefined, NOW, NOW)).toBeUndefined();
  });

  it('shows what it was told a little while ago at once, while the answer is on its way', () => {
    const earlier = mantel(['p1', 'p2'], NOW - 10 * 60_000);

    expect(mantelToShow(earlier, NOW, NOW + 100)).toBe(earlier);
  });

  it('does not show what is too old to load, nor an empty mantelpiece from before: it waits', () => {
    expect(mantelToShow(mantel(['p1'], NOW - MANTEL_FRESH_FOR_MS), NOW, NOW)).toBeUndefined();
    expect(mantelToShow(mantel([], NOW - 60_000), NOW, NOW)).toBeUndefined();
  });

  it('shows the answer to this opening whatever it says — an empty one too, which closes the screen', () => {
    const answer = mantel([], NOW + 800);

    expect(mantelToShow(answer, NOW, NOW + 900)).toBe(answer);
  });
});

describe('the mantelpiece — one picture at a time', () => {
  it('shows nothing but its waiting until the server answers', () => {
    expect(inView(VIEWER_START)).toBeUndefined();
    expect(VIEWER_START.waiting).toBe(true);
    expect(run([{ t: 'mantel', mantel: undefined }])).toEqual({ state: VIEWER_START, effects: [] });
    // Nothing can be pressed on a picture that is not there.
    expect(run([{ t: 'ok' }, { t: 'move', by: 1 }]).state).toEqual(VIEWER_START);
  });

  it('starts at the first picture', () => {
    const state = opened(['p1', 'p2', 'p3']);

    expect(inView(state)?.photoId).toBe('p1');
    expect(state.waiting).toBe(false);
    expect(caption(state)).toEqual({ fromName: 'Sarah', place: 1, count: 3 });
  });

  it('moves right and left between them, and stays at either end', () => {
    let state = opened(['p1', 'p2', 'p3']);

    state = run([{ t: 'move', by: 1 }], state).state;
    expect(caption(state)).toMatchObject({ place: 2, count: 3 });
    state = run([{ t: 'move', by: 1 }, { t: 'move', by: 1 }, { t: 'move', by: 1 }], state).state;
    expect(inView(state)?.photoId).toBe('p3');
    state = run([{ t: 'move', by: -1 }, { t: 'move', by: -1 }, { t: 'move', by: -1 }], state).state;
    expect(inView(state)?.photoId).toBe('p1');
  });

  it('returns to the home screen when the answer is an empty mantelpiece', () => {
    expect(run([{ t: 'mantel', mantel: mantel([]) }]).effects).toEqual([{ t: 'close' }]);
  });

  it('does nothing twice for the same answer', () => {
    const answer = mantel(['p1', 'p2']);
    const moved = run([{ t: 'mantel', mantel: answer }, { t: 'move', by: 1 }]).state;

    expect(run([{ t: 'mantel', mantel: answer }], moved)).toEqual({ state: moved, effects: [] });
  });
});

describe('the mantelpiece — OK opens a choice, and an unread press changes nothing', () => {
  it('opens the choice on OK, about the picture in view', () => {
    const state = run([{ t: 'move', by: 1 }, { t: 'ok' }], opened(['p1', 'p2'])).state;

    expect(state.choosing).toBe(true);
    expect(inView(state)?.photoId).toBe('p2');
  });

  it('does not move between pictures while the choice is open: the arrows are the two buttons’', () => {
    const state = run([{ t: 'ok' }, { t: 'move', by: 1 }], opened(['p1', 'p2'])).state;

    expect(inView(state)?.photoId).toBe('p1');
  });

  it('"Leave it" closes the choice and sends nothing', () => {
    const { state, effects } = run([{ t: 'ok' }, { t: 'leave' }], opened(['p1', 'p2']));

    expect(state.choosing).toBe(false);
    expect(inView(state)?.photoId).toBe('p1');
    expect(effects).toEqual([]);
  });

  it('"Take it down" names the picture in view, once, and waits for the mantelpiece as it now stands', () => {
    const { state, effects } = run([{ t: 'move', by: 1 }, { t: 'ok' }, { t: 'take_down' }], opened(['p1', 'p2', 'p3']));

    expect(effects).toEqual([{ t: 'take_down', photoId: 'p2' }]);
    expect(state.choosing).toBe(false);
    expect(state.waiting).toBe(true);
    // Until the answer comes there is nothing to press or to move to.
    expect(run([{ t: 'ok' }, { t: 'take_down' }, { t: 'move', by: 1 }], state)).toEqual({ state, effects: [] });
  });

  it('takes nothing down without the choice open: only that button does it', () => {
    expect(run([{ t: 'take_down' }], opened(['p1'])).effects).toEqual([]);
  });

  it('shows the picture that took its place when the answer comes, and the last one when the last was taken', () => {
    const middle = run([{ t: 'move', by: 1 }, { t: 'ok' }, { t: 'take_down' }, { t: 'mantel', mantel: mantel(['p1', 'p3'], NOW + 1) }], opened(['p1', 'p2', 'p3'])).state;
    expect(middle.waiting).toBe(false);
    expect(inView(middle)?.photoId).toBe('p3');
    expect(caption(middle)).toMatchObject({ place: 2, count: 2 });

    const last = run([{ t: 'move', by: 1 }, { t: 'move', by: 1 }, { t: 'ok' }, { t: 'take_down' }, { t: 'mantel', mantel: mantel(['p1', 'p2'], NOW + 1) }], opened(['p1', 'p2', 'p3'])).state;
    expect(inView(last)?.photoId).toBe('p2');
  });

  it('goes back to the home screen when the one she took down was the only one', () => {
    const { effects } = run([{ t: 'ok' }, { t: 'take_down' }, { t: 'mantel', mantel: mantel([], NOW + 1) }], opened(['p1']));

    expect(effects).toEqual([{ t: 'take_down', photoId: 'p1' }, { t: 'close' }]);
  });

  it('keeps the picture she is looking at in view when the mantelpiece changes around it', () => {
    const state = run([{ t: 'move', by: 1 }, { t: 'move', by: 1 }, { t: 'mantel', mantel: mantel(['p0', 'p1', 'p3'], NOW + 1) }], opened(['p1', 'p2', 'p3'])).state;

    expect(inView(state)?.photoId).toBe('p3');
    expect(caption(state)).toMatchObject({ place: 3, count: 3 });
  });

  it('closes a choice about a picture that is no longer there', () => {
    const state = run([{ t: 'ok' }, { t: 'mantel', mantel: mantel(['p2'], NOW + 1) }], opened(['p1', 'p2'])).state;

    expect(state.choosing).toBe(false);
    expect(inView(state)?.photoId).toBe('p2');
  });
});

describe('the mantelpiece — Back', () => {
  it('closes the choice first, and changes nothing', () => {
    const { state, effects } = run([{ t: 'ok' }, { t: 'back' }], opened(['p1']));

    expect(state.choosing).toBe(false);
    expect(effects).toEqual([]);
  });

  it('then closes the screen — also while it is still waiting for an answer', () => {
    expect(run([{ t: 'back' }], opened(['p1'])).effects).toEqual([{ t: 'close' }]);
    expect(run([{ t: 'back' }]).effects).toEqual([{ t: 'close' }]);
  });
});

describe('the mantelpiece — a picture whose address no longer answers', () => {
  it('asks the server again, once for each answer it was given', () => {
    const first = run([{ t: 'failed', photoId: 'p1' }], opened(['p1', 'p2']));
    expect(first.effects).toEqual([{ t: 'ask' }]);

    // Another picture of the same answer fails too: it has been asked already.
    expect(run([{ t: 'failed', photoId: 'p2' }, { t: 'failed', photoId: 'p1' }], first.state).effects).toEqual([]);

    // A new answer whose picture fails as well: once more, and no more than that.
    const second = run([{ t: 'mantel', mantel: mantel(['p1', 'p2'], NOW + 5_000) }, { t: 'failed', photoId: 'p1' }, { t: 'failed', photoId: 'p1' }], first.state);
    expect(second.effects).toEqual([{ t: 'ask' }]);
  });

  it('can still be taken down: the choice opens on a picture that cannot be shown', () => {
    const { state, effects } = run([{ t: 'failed', photoId: 'p1' }, { t: 'ok' }, { t: 'take_down' }], opened(['p1']));

    expect(state.waiting).toBe(true);
    expect(effects).toEqual([{ t: 'ask' }, { t: 'take_down', photoId: 'p1' }]);
  });
});

describe('overMantel — a card that becomes releasable while the mantelpiece is open', () => {
  const queued = (urgency: 'DOOR' | 'DEFERRED'): QueuedCard => ({ id: urgency, urgency, queuedAt: 0, shownCount: 0, card: { type: 'DOOR', id: urgency, householdId: 'h', correlationId: 'c', createdAt: 0, actions: [], line: 'x' } });

  it('lets the door through at once: it is the one card that never waits (INV-5)', () => {
    const door = queued('DOOR');

    expect(overMantel(door, true)).toBe(door);
  });

  it('holds a note until she leaves the screen she asked for', () => {
    expect(overMantel(queued('DEFERRED'), true)).toBeUndefined();
  });

  it('changes nothing when the mantelpiece is not open', () => {
    const note = queued('DEFERRED');

    expect(overMantel(note, false)).toBe(note);
    expect(overMantel(undefined, false)).toBeUndefined();
    expect(overMantel(undefined, true)).toBeUndefined();
  });
});

describe('pictureRefresher — a picture card whose address has run out', () => {
  it('asks for the cards again the first time a card’s picture cannot be shown', () => {
    const refresh = pictureRefresher();

    expect(refresh.due('photo-p1', NOW)).toBe(true);
  });

  it('does not ask again for that card while a new address would still be good: if it failed again, asking again would not help', () => {
    const refresh = pictureRefresher();
    refresh.due('photo-p1', NOW);

    expect(refresh.due('photo-p1', NOW + 1_000)).toBe(false);
    expect(refresh.due('photo-p1', NOW + MANTEL_FRESH_FOR_MS - 1)).toBe(false);
  });

  it('asks again when the card has waited so long that the address it was then given has run out too', () => {
    const refresh = pictureRefresher();
    refresh.due('photo-p1', NOW);

    expect(refresh.due('photo-p1', NOW + MANTEL_FRESH_FOR_MS)).toBe(true);
    expect(refresh.due('photo-p1', NOW + MANTEL_FRESH_FOR_MS + 1_000)).toBe(false);
  });

  it('keeps each card’s own count', () => {
    const refresh = pictureRefresher();
    refresh.due('photo-p1', NOW);

    expect(refresh.due('photo-p2', NOW + 1_000)).toBe(true);
    expect(refresh.due('photo-p1', NOW + 2_000)).toBe(false);
  });
});
