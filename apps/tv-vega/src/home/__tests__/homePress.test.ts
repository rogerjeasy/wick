/**
 * A press meant for a card must not fall through to what is underneath.
 *
 * Seen on the Fire OS emulator on main 2528be8: two OK presses 317 ms
 * apart on the first of two notes. The first answered the note. The second
 * note had not been picked yet, so the home screen was back within the
 * remote's reach with a film focused — and the second press started Big
 * Buck Bunny.
 *
 * The rule: the home screen's items take no press for one second after the
 * home comes back within the remote's reach — after a card goes, her
 * mantelpiece closes, the idle screen ends, a film closes, or Wick returns
 * from behind another app. It is the card's own rule (press/settle.ts), by
 * the same second, counted from the same moment the home screen's memory of
 * where she was counts from (home/focusMemory.ts): one notion of "the home
 * has just come back". Only presses: the D-pad moves the focus as it always
 * did, and OK held for two seconds still brings the offer to ask someone to
 * ring her.
 *
 * The home screen is modelled here as HomeScreen.tsx keeps it — the same
 * pure functions, in the same order — and HomeScreen.tsx is read as source
 * at the end, so a press that reaches an item without the rule fails here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IDLE_OFF, idleOnKey, type Idle } from '../../mantel/idle.js';
import { pressBegins, pressEnds } from '../../press/held.js';
import { PRESS_SETTLE_MS, pressActs, pressSettle } from '../../press/settle.js';
import { HOLD_MS } from '../../watch/hold.js';
import { homeBehind } from '../behind.js';
import { FOCUS_SETTLE_MS, HOME_FOCUS_START, focusOnReturn, focusReported, reachChanged, type HomeFocus } from '../focusMemory.js';

const T = 1_800_000_000_000;
const FILMS = ['programme:big-buck-bunny', 'programme:sintel', 'programme:tears-of-steel'];

/** The resident's television with the home screen up: what ResidentApp and HomeScreen do, without React. */
function television(at: number = T) {
  let focus: HomeFocus = HOME_FOCUS_START;
  const tv = {
    card: null as string | null,
    mantelOpen: false,
    idle: IDLE_OFF as Idle,
    onScreen: true,
    watching: false,
    /** What a press on the home screen came to. */
    started: [] as string[],
    opened: [] as string[],
    holds: 0,
    sent: [] as unknown[],
    cards: pressSettle(),
    /** The screen is drawn: HomeScreen says whether it is within the remote's reach, as at every drawing. */
    draw(now: number) {
      tv.cards.appeared(tv.card, now);
      if (tv.watching) {
        // A film is on screen: there is no home screen at all, and none when it comes back remembers this one.
        focus = HOME_FOCUS_START;
        return tv;
      }
      const behind = homeBehind({ card: tv.card !== null, mantelOpen: tv.mantelOpen, idle: tv.idle });
      focus = reachChanged(focus, behind.rows && behind.reach && tv.onScreen, now);
      return tv;
    },
    /** OK pressed and let go on whatever item has the focus — begun when the key goes down, seen when it comes up. */
    ok(item: string, seenAt: number, heldFor = 80): boolean {
      // HomeScreen `pressIn`: the press begins on the item, if the home is within reach (press/held.ts).
      const beganAt = pressBegins({ reachableSince: focus.reachableSince, now: seenAt - heldFor, okDownSince: null });
      // The platform's own long press: OK held for two seconds is the hold, and then it is not a press.
      if (heldFor >= HOLD_MS) {
        tv.holds += 1;
        return false;
      }
      // HomeScreen `press`: it began here, and the home's first second is over.
      if (!pressEnds({ keyCameUp: true, reachableSince: focus.reachableSince, beganAt, now: seenAt })) return false;
      if (item.startsWith('programme:')) tv.started.push(item);
      else tv.opened.push(item);
      return true;
    },
    /** The D-pad moves the focus to an item. */
    moveTo(item: string, now: number) {
      focus = focusReported(focus, item, now);
      return tv;
    },
    remembers: () => focus.item,
    returnsTo: () => focusOnReturn(focus, ['light', ...FILMS, 'waiting', 'mantel'], FILMS[0]!),
  };
  return tv.draw(at);
}

describe('the sequence seen on the emulator — a second OK, 317 ms after the one that answered a note', () => {
  it('starts no film and sends nothing; a press after the second does', () => {
    const tv = television();
    // A note is on screen, long enough to be read.
    tv.card = 'note-1';
    tv.draw(T + 30_000);

    // The first OK answers it: the card is put away, and the home screen is within reach again.
    expect(tv.cards.acts(T + 40_000)).toBe(true);
    tv.card = null;
    tv.draw(T + 40_000);

    // The second OK, 317 ms later, lands on the film that has the focus. The next note has not been picked yet.
    expect(tv.ok(FILMS[0]!, T + 40_317)).toBe(false);
    expect(tv.started).toEqual([]);
    expect(tv.opened).toEqual([]);
    expect(tv.sent).toEqual([]);

    // She meant it: OK again, 1.1 seconds after the home came back.
    expect(tv.ok(FILMS[0]!, T + 41_100)).toBe(true);
    expect(tv.started).toEqual([FILMS[0]]);
  });

  it('covers the next note too when it is picked inside that second: its own buttons take no press in its own first second', () => {
    const tv = television();
    tv.card = 'note-1';
    tv.draw(T + 30_000);
    tv.card = null;
    tv.draw(T + 40_000);

    // The look picks the second note 600 ms later.
    tv.card = 'note-2';
    tv.draw(T + 40_600);

    // A press at 900 ms is neither the home's — it is behind a card — nor yet the card's.
    expect(tv.ok(FILMS[0]!, T + 40_900)).toBe(false);
    expect(tv.cards.acts(T + 40_900)).toBe(false);
    expect(tv.cards.acts(T + 40_600 + PRESS_SETTLE_MS)).toBe(true);
  });

  it('does not make the wait longer by being pressed early, however often', () => {
    const tv = television();
    tv.card = 'note-1';
    tv.draw(T + 30_000);
    tv.card = null;
    tv.draw(T + 40_000);

    for (const at of [100, 300, 500, 700, 900, 999]) expect(tv.ok(FILMS[0]!, T + 40_000 + at), String(at)).toBe(false);
    // Drawn again in the meantime, as it is once a second: still the same second.
    tv.draw(T + 40_950);

    expect(tv.ok(FILMS[0]!, T + 40_000 + PRESS_SETTLE_MS)).toBe(true);
    expect(tv.started).toHaveLength(1);
  });
});

describe('every way the home screen comes back within reach', () => {
  it('her mantelpiece closed with Back, and OK at once: it is not opened again', () => {
    const tv = television();
    tv.moveTo('mantel', T + 5_000);
    expect(tv.ok('mantel', T + 6_000)).toBe(true);
    tv.mantelOpen = true;
    tv.draw(T + 6_000);

    // Back, a minute later. The focus is on the pill again.
    tv.mantelOpen = false;
    tv.draw(T + 66_000);

    expect(tv.ok('mantel', T + 66_150)).toBe(false);
    expect(tv.opened).toEqual(['mantel']);
    expect(tv.ok('mantel', T + 67_000)).toBe(true);
  });

  it('the idle screen ended by a key, then OK: the key that ended it is taken whole, and the next press in that second starts nothing', () => {
    const tv = television();
    tv.idle = { phase: 'on', startedAt: T + 180_000 };
    tv.draw(T + 180_000);
    expect(tv.ok(FILMS[0]!, T + 200_000)).toBe(false);

    // OK ends her pictures. Until it has come up the home is in view and out of reach.
    tv.idle = idleOnKey(tv.idle, { eventType: 'enter', eventKeyAction: 0 }, T + 240_000);
    tv.draw(T + 240_000);
    expect(tv.ok(FILMS[0]!, T + 240_050)).toBe(false);
    tv.idle = idleOnKey(tv.idle, { eventType: 'enter', eventKeyAction: 1 }, T + 240_120);
    tv.draw(T + 240_120);
    expect(tv.idle).toBe(IDLE_OFF);

    // And then its own second, from when it came back within reach.
    expect(tv.ok(FILMS[0]!, T + 240_400)).toBe(false);
    expect(tv.ok(FILMS[0]!, T + 241_120)).toBe(true);
    expect(tv.started).toEqual([FILMS[0]]);
  });

  it('Wick coming back from behind another app: what is on the home screen starts its second again', () => {
    const tv = television();
    expect(tv.ok(FILMS[0]!, T + 30_000)).toBe(true);
    tv.started.length = 0;

    tv.onScreen = false;
    tv.draw(T + 60_000);
    tv.onScreen = true;
    tv.draw(T + 600_000);

    expect(tv.ok(FILMS[0]!, T + 600_317)).toBe(false);
    expect(tv.ok(FILMS[0]!, T + 601_000)).toBe(true);
  });

  it('a film that closes — it ended, or she pressed Back: the home takes no press in its first second', () => {
    const tv = television();
    tv.watching = true;
    tv.draw(T + 10_000);

    // The film ends with her thumb still busy on OK.
    tv.watching = false;
    tv.draw(T + 600_000);

    expect(tv.ok(FILMS[0]!, T + 600_200)).toBe(false);
    expect(tv.started).toEqual([]);
    expect(tv.ok(FILMS[0]!, T + 601_000)).toBe(true);
  });

  it('the first time it appears, at launch: the same second — there is nothing on it yet that she can have aimed at', () => {
    const tv = television(T);

    expect(tv.ok(FILMS[0]!, T + 400)).toBe(false);
    expect(tv.ok(FILMS[0]!, T + PRESS_SETTLE_MS)).toBe(true);
  });

  it('never takes a press while it is behind something, however long', () => {
    const tv = television();
    tv.card = 'note-1';
    tv.draw(T + 5_000);
    expect(tv.ok(FILMS[0]!, T + 90_000)).toBe(false);

    tv.card = null;
    tv.mantelOpen = true;
    tv.draw(T + 91_000);
    expect(tv.ok(FILMS[0]!, T + 190_000)).toBe(false);
  });
});

describe('what the second does not touch', () => {
  it('OK held for two seconds, begun 300 ms after the home came back: it still brings the offer to ask someone to ring her', () => {
    const tv = television();
    tv.card = 'note-1';
    tv.draw(T + 30_000);
    tv.card = null;
    tv.draw(T + 40_000);

    // Down at 300 ms, held; the platform's long press fires two seconds later. No press, no film.
    const pressed = tv.ok(FILMS[0]!, T + 40_300 + HOLD_MS, HOLD_MS);

    expect(pressed).toBe(false);
    expect(tv.holds).toBe(1);
    expect(tv.started).toEqual([]);
  });

  it('the D-pad: the focus moves in that second as at any other time', () => {
    const tv = television();
    tv.card = 'note-1';
    tv.draw(T + 30_000);
    tv.card = null;
    tv.draw(T + 40_000);

    // Right, 600 ms after the home came back: past the moment the platform takes to settle the focus, and hers.
    tv.moveTo(FILMS[1]!, T + 40_000 + FOCUS_SETTLE_MS + 100);

    expect(tv.remembers()).toBe(FILMS[1]);
    // …though OK on it is still inside the second.
    expect(tv.ok(FILMS[1]!, T + 40_800)).toBe(false);
    expect(tv.ok(FILMS[1]!, T + 41_000)).toBe(true);
    expect(tv.started).toEqual([FILMS[1]]);
  });

  it('where she was: the two rules count from the same moment, and the shorter is inside the longer', () => {
    const tv = television();
    tv.moveTo(FILMS[1]!, T + 5_000);
    tv.card = 'note-1';
    tv.draw(T + 30_000);
    tv.card = null;
    tv.draw(T + 40_000);

    // The platform sets the focus down on the way back: not remembered, and not pressable either.
    tv.moveTo('light', T + 40_030);
    expect(tv.returnsTo()).toBe(FILMS[1]);
    expect(FOCUS_SETTLE_MS).toBeLessThanOrEqual(PRESS_SETTLE_MS);
    // No moment in which a focus is hers and the home is not yet counted as back, or the other way round.
    for (const at of [0, 100, 499, 500, 999, 1_000]) {
      const remembered = focusReported(reachChanged(HOME_FOCUS_START, true, T), 'x', T + at).item === 'x';
      expect(remembered || !pressActs(T, T + at), String(at)).toBe(true);
    }
  });
});

describe('HomeScreen.tsx — every press goes through the rule', () => {
  const screen = readFileSync(fileURLToPath(new URL('../HomeScreen.tsx', import.meta.url)), 'utf8');
  const code = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

  it('asks the one rule, from the moment the home came within reach — the same moment its memory of the focus counts from', () => {
    // Through press/held.ts, whose timing is `pressActs` and nothing else (press/__tests__/held.test.ts).
    expect(code).toMatch(/const press =[\s\S]{0,300}pressEnds\(\{ keyCameUp: byKey, reachableSince: focus\.current\.reachableSince, beganAt: began\.current, now: Date\.now\(\) \}\)/);
    expect(code).not.toMatch(/PRESS_SETTLE_MS|setTimeout|1_?000/);
    const held = readFileSync(fileURLToPath(new URL('../../press/held.ts', import.meta.url)), 'utf8');
    expect(held).toMatch(/return pressActs\(at\.reachableSince, at\.now\);/);
    expect(held).not.toMatch(/PRESS_SETTLE_MS|setTimeout|\d_?000/);
  });

  it('gives a film, the waiting row, the light’s pill, the mantelpiece’s pill and Easier to see no other way to be pressed', () => {
    const presses = [...code.matchAll(/onPress=\{([^\n]+)\}\n/g)].map((m) => m[1]);

    expect(presses).toEqual(['press(() => onChoose(programme))', 'press(onOpenWaiting)', 'press(onOpenLight)', 'press(onOpenMantel)', 'press(onOpenSeeing)']);
    expect(code.match(/<Pressable\b/g)).toHaveLength(presses.length);
  });

  it('leaves the hold, and the key coming up, exactly as they were: neither is a press', () => {
    expect(code.match(/onLongPress=\{onHold\}/g)).toHaveLength(5);
    // The key coming up is still told to the app, every time, through the screen's own note of it.
    expect(code.match(/onPressOut=\{pressOut\}/g)).toHaveLength(5);
    expect(code).toMatch(/keyCameUp\.current = true;\s*onKeyUp\?\.\(\);/);
    expect(code.match(/delayLongPress=\{HOLD_MS\}/g)).toHaveLength(5);
  });

  it('counts the home as back only when Wick is the app on screen', () => {
    expect(code).toMatch(/focus\.current = reachChanged\(focus\.current, drawn && !cardVisible && inFront, Date\.now\(\)\);/);
  });
});

describe('ResidentApp.tsx — the home screen is told when Wick is in front', () => {
  const app = readFileSync(fileURLToPath(new URL('../../ResidentApp.tsx', import.meta.url)), 'utf8');

  it('says so from the same thing the card’s guard goes by', () => {
    const home = app.slice(app.indexOf('<HomeScreen'), app.indexOf('/>', app.indexOf('<HomeScreen')));

    expect(home).toMatch(/inFront=\{onScreen\}/);
    expect(app).toMatch(/if \(onScreen && !wasOnScreen\.current\) settle\.returned\(Date\.now\(\)\);/);
  });

  it('puts no guard of its own on what the home screen opens: the rule is in one place', () => {
    for (const handler of ['handleChoose', 'handleOpenWaiting', 'handleOpenLight', 'handleOpenMantel']) {
      const body = app.slice(app.indexOf(`const ${handler} = React.useCallback(`), app.indexOf('}, [', app.indexOf(`const ${handler} = React.useCallback(`)));
      expect(body, handler).not.toMatch(/settle\.|pressActs/);
    }
  });
});
