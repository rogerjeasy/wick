/**
 * Where she was on the home screen (home/focusMemory.ts): the item the
 * focus goes back to when a card, her mantelpiece or the idle screen has
 * gone.
 *
 * The rule: the memory records only a focus she made. Seen on the Vega
 * simulator, 2026-10-14, on the build of PR #52: with the focus on the
 * first film she held OK, answered the card that came, and found the focus
 * on the third film. She had never been there. When a card takes the
 * remote, the home's items stop being focusable one after another in the
 * order they are drawn, and the platform hands the focus along the ones
 * that still are — first film, second, third — before the card's button
 * takes it; each of those was written down as where she was.
 *
 * So a focus reported while the home is out of the remote's reach is not
 * hers, and neither is one reported in the moment after the home comes
 * back into reach, while the platform is still putting the focus where it
 * was told to. Everything here is plain code: the items are names, and the
 * platform is the reports a test says it made.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FOCUS_SETTLE_MS, HOME_FOCUS_START, focusOnReturn, focusReported, isHerFocus, reachChanged, type HomeFocus } from '../focusMemory.js';

const FILMS = ['programme:big-buck-bunny', 'programme:sintel', 'programme:tears-of-steel'] as const;
const [FIRST, SECOND, THIRD] = FILMS;
const NOW = 1_800_000_000_000;

/** The home screen as HomeScreen.tsx keeps it: what is on it, and the memory. */
function home(items: readonly string[] = FILMS, lastWatched?: string) {
  let focus: HomeFocus = HOME_FOCUS_START;
  let now = NOW;
  const screen = {
    items: [...items],
    /** Time passes. */
    later(ms: number) {
      now += ms;
      return screen;
    },
    /** The home comes into the remote's reach, or goes out of it: said at every drawing, as the screen does. */
    reach(reachable: boolean) {
      focus = reachChanged(focus, reachable, now);
      return screen;
    },
    /** An item says it has the focus — whoever put it there. */
    focused(...reports: readonly string[]) {
      for (const item of reports) focus = focusReported(focus, item, now);
      return screen;
    },
    /** She moves the focus with the D-pad, having had time to see the screen. */
    sheMovesTo(item: string) {
      return screen.later(2_000).focused(item);
    },
    /** A card takes the remote: the platform hands the focus along the items still focusable, in the order they are drawn, from where it was. */
    cardComes(from: string) {
      screen.reach(false);
      const order = screen.items;
      return screen.focused(...order.slice(order.indexOf(from) + 1));
    },
    /** Where the focus is put when the home has the remote again. */
    returnsTo() {
      return focusOnReturn(focus, screen.items, lastWatched ?? screen.items.find((item) => item.startsWith('programme:'))!);
    },
    /** The home has the remote again: the platform puts the focus where it is told — and may visit another item on the way. */
    cardGoes(strays: readonly string[] = []) {
      screen.reach(true);
      const to = screen.returnsTo();
      screen.later(30).focused(...strays, to);
      return to;
    },
  };
  // First launch: the home is drawn within reach, and the platform focuses where it is told.
  screen.reach(true).later(40).focused(screen.returnsTo());
  return screen;
}

describe('isHerFocus — the rule', () => {
  it('is hers when the home is within the remote’s reach and has been for a moment', () => {
    expect(isHerFocus({ reachable: true, sinceReachableMs: FOCUS_SETTLE_MS })).toBe(true);
    expect(isHerFocus({ reachable: true, sinceReachableMs: 60_000 })).toBe(true);
  });

  it('is not hers while the home is out of reach: a card, her mantelpiece or the idle screen has the remote', () => {
    expect(isHerFocus({ reachable: false, sinceReachableMs: 0 })).toBe(false);
    expect(isHerFocus({ reachable: false, sinceReachableMs: 60_000 })).toBe(false);
  });

  it('is not hers in the moment after the home comes back into reach: the platform is still putting the focus down', () => {
    expect(isHerFocus({ reachable: true, sinceReachableMs: 0 })).toBe(false);
    expect(isHerFocus({ reachable: true, sinceReachableMs: FOCUS_SETTLE_MS - 1 })).toBe(false);
  });

  it('is a moment shorter than it takes to see the screen and press: half a second', () => {
    expect(FOCUS_SETTLE_MS).toBe(500);
  });
});

describe('the sequence seen on the simulator — hold OK on the first film, answer the card', () => {
  it('returns the focus to the first film, not to the third the platform passed through', () => {
    const screen = home();
    expect(screen.returnsTo()).toBe(FIRST);

    // OK held: the offer to ask someone to ring her arrives, and its first button takes the focus. On the way
    // the home's items go out of reach one by one, and the second and third films each report the focus.
    screen.later(30_000).cardComes(FIRST);
    // Down to "No, not now"; Play, and the card is read; OK. None of that is on the home screen.
    screen.later(20_000);

    expect(screen.cardGoes()).toBe(FIRST);
  });

  it('would have gone to the third film had those reports been believed', () => {
    let believed: HomeFocus = reachChanged(HOME_FOCUS_START, true, NOW);
    // What the memory did before: every report was where she was.
    for (const item of [SECOND, THIRD]) believed = { ...believed, item };

    expect(focusOnReturn(believed, FILMS, FIRST)).toBe(THIRD);
  });

  it('stays right however many times it happens', () => {
    const screen = home();
    for (let round = 0; round < 3; round += 1) {
      screen.later(10_000).cardComes(FIRST);
      expect(screen.later(5_000).cardGoes(), `round ${round}`).toBe(FIRST);
    }
  });
});

describe('where the focus returns', () => {
  it('first launch: the first film — and the film she last watched, when she has come back from one', () => {
    expect(home().returnsTo()).toBe(FIRST);
    expect(home(FILMS, SECOND).returnsTo()).toBe(SECOND);
  });

  it('a card arrives while she is on the second film: back on the second film', () => {
    const screen = home();
    screen.sheMovesTo(SECOND);

    screen.later(5_000).cardComes(SECOND);

    expect(screen.later(8_000).cardGoes()).toBe(SECOND);
  });

  it('the Light card opened from the pill: back on the pill', () => {
    const screen = home(['light', ...FILMS]);
    screen.sheMovesTo('light');

    // OK on the pill; the card that answers it arrives a second later, and the films pass the focus along.
    screen.later(1_000).cardComes('light');

    expect(screen.later(6_000).cardGoes()).toBe('light');
  });

  it('a waiting note opened from its row, and her mantelpiece from its pill: back on the row, and on the pill', () => {
    const items = ['light', ...FILMS, 'waiting', 'mantel'];

    const note = home(items);
    note.sheMovesTo('waiting');
    note.later(500).cardComes('waiting');
    expect(note.later(4_000).cardGoes()).toBe('waiting');

    const mantel = home(items);
    mantel.sheMovesTo('mantel');
    mantel.later(500).reach(false);
    expect(mantel.later(60_000).cardGoes()).toBe('mantel');
  });

  it('the idle screen ending: where she was', () => {
    const screen = home(['light', ...FILMS, 'mantel']);
    screen.sheMovesTo(SECOND);

    // Three minutes untouched: her pictures fill the screen, and the home's items go out of reach — the third
    // film and the mantelpiece's pill each report the focus as it is handed along.
    screen.later(180_000).cardComes(SECOND);
    // A key ends it. The home is in view again and still out of reach until the key is up; then it is hers.
    screen.later(40_000).reach(false);

    expect(screen.later(150).cardGoes()).toBe(SECOND);
  });

  it('is not moved by an item the platform visits on the way back', () => {
    const screen = home(['light', ...FILMS]);
    screen.sheMovesTo(SECOND);
    screen.later(5_000).cardComes(SECOND);

    // The rows are drawn again: the first thing that can take the focus is the light's pill, then the nearest film.
    expect(screen.later(5_000).cardGoes(['light', FIRST])).toBe(SECOND);
    // And the next card finds her where she was.
    screen.later(10_000).cardComes(SECOND);
    expect(screen.later(5_000).cardGoes(['light'])).toBe(SECOND);
  });

  it('follows her when she moves again after the home has come back', () => {
    const screen = home();
    screen.later(5_000).cardComes(FIRST);
    screen.later(5_000).cardGoes();

    screen.sheMovesTo(THIRD);
    screen.later(5_000).cardComes(THIRD);

    expect(screen.later(5_000).cardGoes()).toBe(THIRD);
  });

  it('goes to the first film when what she was on is no longer there: the waiting row once the note is answered', () => {
    const screen = home([...FILMS, 'waiting']);
    screen.sheMovesTo('waiting');
    screen.later(500).cardComes('waiting');

    screen.items = [...FILMS];

    expect(screen.later(4_000).cardGoes()).toBe(FIRST);
  });
});

describe('the memory, step by step', () => {
  it('knows nothing at first, and learns nothing from the focus the platform places at launch', () => {
    const launched = focusReported(reachChanged(HOME_FOCUS_START, true, NOW), FIRST, NOW + 50);

    expect(launched.item).toBeUndefined();
    expect(focusOnReturn(launched, FILMS, FIRST)).toBe(FIRST);
  });

  it('counts the moment from when the home came into reach — not from every drawing of it', () => {
    let focus = reachChanged(HOME_FOCUS_START, true, NOW);
    // Drawn again and again while in reach, as it is once a second.
    for (let second = 1; second <= 5; second += 1) focus = reachChanged(focus, true, NOW + second * 1_000);

    expect(focusReported(focus, SECOND, NOW + 5_100).item).toBe(SECOND);
  });

  it('starts the moment again each time the home comes back into reach', () => {
    let focus = reachChanged(HOME_FOCUS_START, true, NOW);
    focus = focusReported(focus, SECOND, NOW + 2_000);
    focus = reachChanged(focus, false, NOW + 3_000);
    focus = reachChanged(focus, true, NOW + 9_000);

    expect(focusReported(focus, THIRD, NOW + 9_100).item).toBe(SECOND);
    expect(focusReported(focus, THIRD, NOW + 9_000 + FOCUS_SETTLE_MS).item).toBe(THIRD);
  });

  it('is not undone by a clock that goes back', () => {
    const focus = focusReported(reachChanged(HOME_FOCUS_START, true, NOW), SECOND, NOW - 5_000);

    expect(focus.item).toBeUndefined();
  });
});

describe('HomeScreen.tsx — the memory, as kept', () => {
  const screen = readFileSync(fileURLToPath(new URL('../HomeScreen.tsx', import.meta.url)), 'utf8');

  it('writes it down only through the rule: no item sets where she was by itself', () => {
    expect(screen).not.toMatch(/focused\.current\s*=/);
    expect(screen.match(/focus\.current = /g)).toHaveLength(2);
    expect(screen).toMatch(/focus\.current = reachChanged\(focus\.current, drawn && !cardVisible && inFront, Date\.now\(\)\);/);
    expect(screen).toMatch(/focus\.current = focusReported\(focus\.current, item, Date\.now\(\)\);/);
  });

  it('has every item that can take the focus report it, by its own name', () => {
    const reports = [...screen.matchAll(/onFocus=\{\(\) => reportFocus\(([^)]+)\)\}/g)].map((m) => m[1]);

    expect(reports).toEqual(['`programme:${programme.id}`', "'waiting'", "'light'", "'mantel'", "'seeing'"]);
    expect(screen.match(/<Pressable\b/g)).toHaveLength(reports.length);
  });

  it('puts the focus back where the rule says', () => {
    expect(screen).toMatch(/const preferred = focusOnReturn\(focus\.current, here, start\);/);
    expect(screen).toMatch(/hasTVPreferredFocus=\{!cardVisible && preferred === /);
  });
});
