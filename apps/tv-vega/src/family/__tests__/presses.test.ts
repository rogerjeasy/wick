import { describe, expect, it } from 'vitest';
import type { FamilyTvCard, FamilyTvHome } from '@wick/contracts';
import { ALL_RIGHT, pressed, putAway, showing, waveOf, afterPress, type PutAway } from '../familyScreen.js';
import { ARROW_FOCUS_GRACE_MS, PRESS_SETTLE_MS, pressGuard, surfaceOf, type PressGuard } from '../presses.js';
import { openReader, turn } from '../reader.js';

const T = 1_800_000_000_000;
const ms = (n: number): number => T + n;

const WEEK: FamilyTvCard = {
  id: 'ftv-week-2026-W41',
  kind: 'week',
  headline: 'Margaret’s week is ready to read.',
  pages: ['A quiet week.'],
  actions: [
    { id: 'ftv-read', label: 'Read it', kind: 'primary' },
    { id: 'ftv-later', label: 'Not now', kind: 'dismiss' },
  ],
};
const RING: FamilyTvCard = {
  id: 'ftv-reach-r1',
  kind: 'reach',
  headline: 'Margaret would like you to ring her.',
  actions: [
    { id: 'calling', label: 'I’m ringing you now', kind: 'primary' },
    { id: 'cannot', label: 'I can’t just now', kind: 'secondary' },
  ],
};
const WAVED_BACK: FamilyTvCard = { id: 'ftv-wave-w1', kind: 'wave', headline: 'Margaret waved back.', actions: [{ id: 'seen', label: 'Lovely', kind: 'primary' }] };
const home = (cards: readonly FamilyTvCard[]): FamilyTvHome => ({ residentName: 'Margaret', memberName: 'Sarah', cards, wave: { label: 'Wave to Margaret', cardId: 'ftv-wave-new' } });

const arrow = (eventType: 'up' | 'down' | 'left' | 'right') => ({ eventType, eventKeyAction: 0 });
const OK_DOWN = { eventType: 'select', eventKeyAction: 0 };
const OK_UP = { eventType: 'select', eventKeyAction: 1 };

/**
 * The family home screen as FamilyApp runs it, without React: what is in
 * front, the guard, and where the platform has put the focus. `ok` is one
 * press of OK on whatever has the focus, and says what it did.
 */
function screen(start: FamilyTvHome) {
  let now = ms(0);
  let h = start;
  let put: PutAway = {};
  let said: string | undefined;
  let reading: ReturnType<typeof openReader>;
  /** Where the platform's focus is: a card's button (by id), the wave, the holder that does nothing, or the reader's one button. */
  let focus: string = 'holder';
  const guard: PressGuard = pressGuard();
  const sent: Array<{ cardId: string; action: string }> = [];

  const shown = () => showing(h, put, said);
  const settle = (): void => {
    guard.surface(surfaceOf({ seated: false, reading, shown: shown() }), now);
  };
  /** The platform's default: a card's first button when there is one — and when a card goes, the only focusable left. */
  const handOver = (to?: 'wave' | 'holder'): void => {
    const s = shown();
    if (reading) focus = 'reader';
    else if (s.kind !== 'nothing') focus = s.actions[0]!.id;
    else focus = to ?? 'holder';
    if (focus === 'wave') guard.waveFocused(now);
  };
  settle();
  handOver();

  const api = {
    guard,
    sent,
    get focus() {
      return focus;
    },
    shown,
    later(n: number) {
      now += n;
      return api;
    },
    /** Wick left the screen and came back, and the platform put the focus where it liked. */
    returns(focusOn: 'wave' | 'holder' = 'holder') {
      guard.returned(now);
      handOver(focusOn);
      return api;
    },
    /** A D-pad move the member makes. From the holder, Down reaches the wave. */
    press(key: 'up' | 'down' | 'left' | 'right') {
      guard.key(arrow(key), now);
      if (key === 'down' && focus === 'holder' && waveOf(h)?.kind === 'button' && shown().kind === 'nothing') {
        focus = 'wave';
        guard.waveFocused(now);
      } else if (key === 'up' && focus === 'wave') {
        focus = 'holder';
        guard.waveBlurred();
      } else if (key === 'right' && shown().kind === 'card') {
        const s = shown();
        if (s.kind === 'card') focus = s.actions[Math.min(s.actions.length - 1, s.actions.findIndex((a) => a.id === focus) + 1)]!.id;
      }
      return api;
    },
    /** One press of OK. `handsFocusTo`: where the platform puts the focus if this press takes away what had it. */
    ok(handsFocusTo: 'wave' | 'holder' = 'wave'): string {
      guard.key(OK_DOWN, now);
      guard.key(OK_UP, now);
      if (focus === 'holder') return 'nothing: the holder does nothing';
      if (focus === 'wave') {
        if (!guard.waveActs(now)) return 'swallowed: not aimed at the wave';
        const wave = waveOf(h);
        if (wave?.kind !== 'button') return 'nothing';
        sent.push(wave.press);
        said = 'Your wave is on its way.';
        settle();
        handOver();
        return 'wave sent';
      }
      if (!guard.cardActs(now)) return 'swallowed: too soon after it appeared';
      if (reading) {
        const turned = turn(reading, 'next');
        reading = turned.reading;
        if (turned.press) {
          sent.push(turned.press);
          const after = afterPress(turned.press, { kind: 'said', done: true, say: 'x' }, 'Margaret');
          const card = h.cards.find((c) => c.id === turned.press!.cardId);
          if (after.hide && card) put = putAway(put, card);
        }
        settle();
        handOver(handsFocusTo);
        return reading ? 'page turned' : 'reader closed';
      }
      const what = pressed(shown(), focus);
      if (what.do === 'clearSaid') said = undefined;
      else if (what.do === 'putAway') put = putAway(put, what.card);
      else if (what.do === 'read') reading = what.reading;
      else if (what.do === 'send') {
        sent.push(what.press);
        const after = afterPress(what.press, { kind: 'said', done: true, say: 'Margaret has been told.' }, 'Margaret');
        if (after.say) said = after.say;
        if (after.hide) put = putAway(put, h.cards.find((c) => c.id === what.press.cardId)!);
      }
      settle();
      handOver(handsFocusTo);
      return what.do;
    },
    /** The server's next answer. */
    becomes(next: FamilyTvHome) {
      h = next;
      settle();
      const s = shown();
      // A card that arrives takes the focus for its first button, as CalmCard asks.
      if (s.kind !== 'nothing' && !reading) focus = s.actions[0]!.id;
      return api;
    },
  };
  return api;
}

// Seen on the Fire OS emulator, 2026-10-13: the week card had the focus on
// "Not now". Two presses of OK half a second apart: the first put the card
// away, the wave button appeared WITH the focus, and the second sent a wave
// to her television.
describe('a wave is never sent by a press that was not aimed at it', () => {
  it('"Not now", then OK again half a second later: no wave — then Down and OK: the wave', () => {
    const tv = screen(home([WEEK])).later(5_000);
    tv.press('right');
    expect(tv.focus).toBe('ftv-later');

    expect(tv.ok('wave')).toBe('putAway');
    expect(tv.focus).toBe('wave');
    expect(tv.later(500).ok()).toBe('swallowed: not aimed at the wave');
    // Nor a third, nor one a minute later: a press does not arm the next.
    expect(tv.later(500).ok()).toBe('swallowed: not aimed at the wave');
    expect(tv.later(60_000).ok()).toBe('swallowed: not aimed at the wave');
    expect(tv.sent).toEqual([]);

    tv.later(1_000).press('down');
    expect(tv.ok()).toBe('wave sent');
    expect(tv.sent).toEqual([{ cardId: 'ftv-wave-new', action: 'wave' }]);
  });

  it('holds wherever the platform puts the focus: on the holder the second OK does nothing at all', () => {
    const tv = screen(home([WEEK])).later(5_000);
    tv.press('right');

    expect(tv.ok('holder')).toBe('putAway');
    expect(tv.later(500).ok()).toBe('nothing: the holder does nothing');
    expect(tv.sent).toEqual([]);
  });

  it('leaving the reader from its last page, then OK again: the week is said to be read, and no wave', () => {
    const tv = screen(home([WEEK])).later(5_000);
    expect(tv.ok()).toBe('read');
    expect(tv.later(3_000).ok('wave')).toBe('reader closed');
    expect(tv.focus).toBe('wave');

    expect(tv.later(500).ok()).toBe('swallowed: not aimed at the wave');
    expect(tv.sent).toEqual([{ cardId: WEEK.id, action: 'read' }]);
  });

  it('a quiet press — a wave that came back, seen — then OK again: no wave', () => {
    const tv = screen(home([WAVED_BACK])).later(5_000);

    expect(tv.ok('wave')).toBe('send');
    expect(tv.focus).toBe('wave');
    expect(tv.later(400).ok()).toBe('swallowed: not aimed at the wave');
    expect(tv.sent).toEqual([{ cardId: WAVED_BACK.id, action: 'seen' }]);
  });

  it('"All right" on an answer, then OK again: no wave', () => {
    const tv = screen(home([RING])).later(5_000);
    expect(tv.ok()).toBe('send');
    tv.becomes(home([]));
    expect(tv.shown()).toMatchObject({ kind: 'said' });

    expect(tv.later(3_000).ok('wave')).toBe('clearSaid');
    expect(tv.later(500).ok()).toBe('swallowed: not aimed at the wave');
    expect(tv.sent).toEqual([{ cardId: RING.id, action: 'calling' }]);
  });

  it('the card taken away by the server while the focus was on it, then OK: no wave', () => {
    const tv = screen(home([RING])).later(5_000);
    tv.becomes(home([]));
    // The platform hands the focus to the only thing left.
    tv.returns('wave');

    expect(tv.later(200).ok()).toBe('swallowed: not aimed at the wave');
    expect(tv.sent).toEqual([]);
  });

  it('the screen’s first appearance with the focus handed to the wave: OK does nothing until an arrow has been pressed', () => {
    const tv = screen(home([]));
    tv.returns('wave');

    expect(tv.later(10_000).ok()).toBe('swallowed: not aimed at the wave');
    tv.press('down');
    expect(tv.ok()).toBe('wave sent');
  });

  it('back from the background with the focus where it was left, on the wave: OK does nothing until an arrow has been pressed', () => {
    const tv = screen(home([])).later(5_000);
    tv.press('down');
    expect(tv.focus).toBe('wave');

    // The member walks away with the wave focused and armed. An hour later the app comes back on screen.
    tv.later(3_600_000).returns('wave');
    expect(tv.ok()).toBe('swallowed: not aimed at the wave');

    tv.press('up').press('down');
    expect(tv.ok()).toBe('wave sent');
  });

  it('an arrow pressed on the card before it went does not count: the move was made on something else', () => {
    const tv = screen(home([WEEK])).later(5_000);
    tv.press('right');

    // Right, then OK at once on "Not now" — and the focus is handed to the wave 16 ms later.
    expect(tv.later(100).ok('wave')).toBe('putAway');
    expect(tv.later(100).ok()).toBe('swallowed: not aimed at the wave');
  });

  it('moving off the wave and having the focus handed back is not aiming at it', () => {
    const tv = screen(home([])).later(5_000);
    tv.press('down').press('up');
    expect(tv.focus).toBe('holder');

    // Something hands the focus back to the wave, long after the last arrow.
    tv.later(5_000);
    tv.guard.waveFocused(ms(10_000) + 5_000);
    expect(tv.guard.waveActs(ms(10_000) + 5_100)).toBe(false);
  });
});

describe('the wave guard, by itself', () => {
  it('acts only after an arrow key: the D-pad move that brought the focus there, whichever of the two arrives first', () => {
    // Vega: the key is heard, then the focus arrives.
    const keyFirst = pressGuard();
    keyFirst.surface('home', ms(0));
    keyFirst.key(arrow('down'), ms(5_000));
    keyFirst.waveFocused(ms(5_020));
    expect(keyFirst.waveActs(ms(6_000))).toBe(true);

    // Fire OS: the focus moves as the key goes down, and the key is heard as it comes up.
    const focusFirst = pressGuard();
    focusFirst.surface('home', ms(0));
    focusFirst.waveFocused(ms(5_000));
    expect(focusFirst.waveActs(ms(5_010))).toBe(false);
    focusFirst.key(arrow('down'), ms(5_090));
    expect(focusFirst.waveActs(ms(6_000))).toBe(true);
  });

  it('does not act for OK, Back or the film keys, however often they are pressed', () => {
    const guard = pressGuard();
    guard.surface('home', ms(0));
    guard.waveFocused(ms(100));
    for (const eventType of ['select', 'enter', 'back', 'playpause', 'play', 'skip_forward', 'rewind', 'menu']) {
      guard.key({ eventType, eventKeyAction: 0 }, ms(200));
      guard.key({ eventType, eventKeyAction: 1 }, ms(300));
    }

    expect(guard.waveActs(ms(5_000))).toBe(false);
  });

  it('is disarmed when the focus leaves it, and when what is on screen changes', () => {
    const left = pressGuard();
    left.surface('home', ms(0));
    left.key(arrow('down'), ms(1_000));
    left.waveFocused(ms(1_010));
    left.waveBlurred();
    expect(left.waveActs(ms(1_500))).toBe(false);

    const changed = pressGuard();
    changed.surface('home', ms(0));
    changed.key(arrow('down'), ms(1_000));
    changed.surface('card:ftv-reach-r1:calling,cannot', ms(2_000));
    changed.surface('home', ms(9_000));
    expect(changed.waveActs(ms(9_500))).toBe(false);
  });

  it('is not aimed at by an arrow pressed a while ago on something else, when the focus is then handed to it', () => {
    const guard = pressGuard();
    guard.surface('home', ms(0));
    // Left, on the heading: the focus goes nowhere.
    guard.key(arrow('left'), ms(1_000));
    // Five seconds later the platform puts the focus on the wave by itself.
    guard.waveFocused(ms(6_000));

    expect(guard.waveActs(ms(6_100))).toBe(false);
    // Just inside the moment that makes an arrow and the focus one move, it is the member's move.
    const moved = pressGuard();
    moved.surface('home', ms(0));
    moved.key(arrow('down'), ms(1_000));
    moved.waveFocused(ms(1_000) + ARROW_FOCUS_GRACE_MS);
    expect(moved.waveActs(ms(2_000))).toBe(true);
  });

  it('still works on a television that never says where the focus is: an arrow since the home appeared is the aim', () => {
    const guard = pressGuard();
    guard.surface('home', ms(0));
    expect(guard.waveActs(ms(5_000))).toBe(false);
    guard.key(arrow('down'), ms(6_000));

    expect(guard.waveActs(ms(6_500))).toBe(true);
  });

  it('takes an arrow that comes without its halves as a move', () => {
    const guard = pressGuard();
    guard.surface('home', ms(0));
    guard.key({ eventType: 'down' }, ms(1_000));

    expect(guard.waveActs(ms(1_100))).toBe(true);
  });

  it('does not take an arrow coming up for a move by itself', () => {
    const guard = pressGuard();
    guard.surface('home', ms(0));
    guard.key({ eventType: 'down', eventKeyAction: 1 }, ms(1_000));

    expect(guard.waveActs(ms(1_100))).toBe(false);
  });
});

// The same accident, with a card in the wave's place: a press meant for one
// card landing on the next one's first button, unread.
describe('a card’s buttons do not act on a press made before the card could be read', () => {
  it('the second of two quick presses does not answer the card that took the first one’s place', () => {
    const tv = screen(home([WEEK, RING])).later(5_000);
    tv.press('right');

    expect(tv.ok()).toBe('putAway');
    expect(tv.shown()).toMatchObject({ kind: 'card', card: RING });
    expect(tv.focus).toBe('calling');
    // Half a second later: "I’m ringing you now" has the focus, and nobody has read it.
    expect(tv.later(500).ok()).toBe('swallowed: too soon after it appeared');
    expect(tv.sent).toEqual([]);

    expect(tv.later(PRESS_SETTLE_MS).ok()).toBe('send');
    expect(tv.sent).toEqual([{ cardId: RING.id, action: 'calling' }]);
  });

  it('nor "All right" on an answer, pressed twice: the next card is left unanswered', () => {
    const tv = screen(home([WAVED_BACK])).later(5_000);
    expect(tv.ok()).toBe('send');
    tv.becomes(home([RING]));

    expect(tv.focus).toBe('calling');
    expect(tv.later(300).ok()).toBe('swallowed: too soon after it appeared');
    expect(tv.sent).toEqual([{ cardId: WAVED_BACK.id, action: 'seen' }]);
  });

  it('nor a card the server puts on screen under a thumb already on its way down', () => {
    const tv = screen(home([])).later(60_000);
    tv.becomes(home([RING]));

    expect(tv.later(PRESS_SETTLE_MS - 1).ok()).toBe('swallowed: too soon after it appeared');
    expect(tv.later(1).ok()).toBe('send');
  });

  it('nor the sentence after a press, nor the reader just opened', () => {
    const tv = screen(home([RING])).later(5_000);
    expect(tv.ok()).toBe('send');
    expect(tv.later(200).ok()).toBe('swallowed: too soon after it appeared');
    expect(tv.shown()).toMatchObject({ kind: 'said' });

    const reader = screen(home([WEEK])).later(5_000);
    expect(reader.ok()).toBe('read');
    // One page: OK is "All right", which says the week was read.
    expect(reader.later(300).ok()).toBe('swallowed: too soon after it appeared');
    expect(reader.sent).toEqual([]);
  });

  it('does not make the member wait on a card they have had time to read, or between the pages of one thing', () => {
    const tv = screen(home([RING])).later(PRESS_SETTLE_MS);
    expect(tv.ok()).toBe('send');

    const pages = screen(home([{ ...WEEK, pages: ['One.', 'Two.', 'Three.'] }])).later(5_000);
    expect(pages.ok()).toBe('read');
    expect(pages.later(PRESS_SETTLE_MS).ok()).toBe('page turned');
    expect(pages.later(100).ok()).toBe('page turned');
  });

  it('starts again when Wick comes back on screen: the card there may not be the one that was left', () => {
    const tv = screen(home([RING])).later(60_000);
    tv.returns();

    expect(tv.later(400).ok()).toBe('swallowed: too soon after it appeared');
    expect(tv.later(PRESS_SETTLE_MS).ok()).toBe('send');
  });

  it('counts the same card with other words as the same card: a look that changes a sentence does not hold the remote up', () => {
    const tv = screen(home([RING])).later(60_000);
    tv.becomes(home([{ ...RING, detail: 'She asked two minutes ago.' }]));

    expect(tv.later(100).ok()).toBe('send');
  });

  it('is a second: longer than two presses meant as one, shorter than reading a sentence', () => {
    expect(PRESS_SETTLE_MS).toBe(1_000);
  });
});

describe('surfaceOf — what there is to press', () => {
  it('is the seat, the reader, the card or sentence in front, or the home with nothing on it', () => {
    const card = showing(home([RING]), {}, undefined);
    const reading = openReader(WEEK)!;

    expect(surfaceOf({ seated: true, reading, shown: card })).toBe('seat');
    expect(surfaceOf({ seated: false, reading, shown: card })).toBe(`reader:${WEEK.id}`);
    expect(surfaceOf({ seated: false, reading: undefined, shown: card })).toBe(card.kind === 'card' ? card.key : '');
    expect(surfaceOf({ seated: false, reading: undefined, shown: showing(home([]), {}, 'Done.') })).toBe('said:Done.');
    expect(surfaceOf({ seated: false, reading: undefined, shown: { kind: 'nothing' } })).toBe('home');
  });

  it('is the same from page to page, and from look to look', () => {
    const reading = openReader({ ...WEEK, pages: ['One.', 'Two.'] })!;

    expect(surfaceOf({ seated: false, reading: { ...reading, page: 1 }, shown: { kind: 'nothing' } })).toBe(surfaceOf({ seated: false, reading, shown: { kind: 'nothing' } }));
    expect(ALL_RIGHT.id).not.toBe('home');
  });
});
