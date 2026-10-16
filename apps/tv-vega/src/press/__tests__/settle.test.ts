import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRESS_SETTLE_MS as FAMILY_PRESS_SETTLE_MS, pressGuard } from '../../family/presses.js';
import { holdGuard } from '../../home/reach.js';
import { PRESS_SETTLE_MS, pressActs, pressSettle } from '../settle.js';

const T = 1_800_000_000_000;
const ms = (n: number): number => T + n;

/**
 * The resident's television as ResidentApp runs it, without React: the card
 * on screen, the guard, and what a press on the card's focused button
 * comes to. `ok` says whether the press was acted on.
 */
function television() {
  const settle = pressSettle();
  const hold = holdGuard();
  const sent: Array<{ cardId: string; action: string }> = [];
  let card: string | null = null;
  const tv = {
    settle,
    hold,
    sent,
    /** The tick puts a card on screen — or the same one again, or none. */
    shows(id: string | null, now: number) {
      card = id;
      settle.appeared(id, now);
      return tv;
    },
    returns(now: number) {
      settle.returned(now);
      return tv;
    },
    /** One press of OK on the card's focused button, seen at `now`. */
    ok(action: string, now: number): boolean {
      if (card === null) return false;
      // ResidentApp.handleAction, top: her thumb coming up from a hold, then the card's first second.
      if (hold.swallows(now)) return false;
      if (!settle.acts(now)) return false;
      sent.push({ cardId: card, action });
      return true;
    },
  };
  return tv;
}

// Her cards are where consent is given: "Allow Sarah", "Tell Sarah", "Start
// the film", "Yes, ask Sarah", "Yes, that's right". When she answers one
// and the next is released a moment later with its first button focused, a
// second OK — a double press, a bouncing key, a press begun before she
// could have read anything — must not answer a question she has not seen.
describe('pressSettle — a card’s buttons take no press in its first second on screen', () => {
  it('the consent sequence: card A answered, card B appears, OK 300 ms later does nothing, OK at 1.1 s answers B', () => {
    const tv = television();
    tv.shows('circle-tom', ms(0));
    expect(tv.ok('allow', ms(8_000))).toBe(true);

    // A is gone; the next card is released at once, "Tell Sarah" focused.
    tv.shows(null, ms(8_010)).shows('tell-d7', ms(9_000));
    expect(tv.ok('tell', ms(9_300))).toBe(false);
    expect(tv.sent).toEqual([{ cardId: 'circle-tom', action: 'allow' }]);

    expect(tv.ok('tell', ms(10_100))).toBe(true);
    expect(tv.sent).toEqual([
      { cardId: 'circle-tom', action: 'allow' },
      { cardId: 'tell-d7', action: 'tell' },
    ]);
  });

  it('counts from when the card came on screen, to the millisecond', () => {
    const settle = pressSettle();
    settle.appeared('tell-d7', ms(0));

    expect(PRESS_SETTLE_MS).toBe(1_000);
    expect(settle.acts(ms(PRESS_SETTLE_MS - 1))).toBe(false);
    expect(settle.acts(ms(PRESS_SETTLE_MS))).toBe(true);
  });

  it('a swallowed press does nothing at all — and does not make her wait longer', () => {
    const tv = television();
    tv.shows('tell-d7', ms(0));

    for (const at of [100, 300, 500, 700, 900]) expect(tv.ok('tell', ms(at))).toBe(false);
    expect(tv.sent).toEqual([]);
    // The second is counted from the card, not from her last press.
    expect(tv.ok('tell', ms(1_000))).toBe(true);
  });

  it('the door, over a film: nothing for an OK already on its way down, and her first OK a second later answers', () => {
    const tv = television();
    // She is watching; nothing is on screen. The doorbell rings.
    tv.shows(null, ms(0)).shows('door-evt-9', ms(600_000));

    // OK meant to pause the film, 200 ms after the card took the remote.
    expect(tv.ok('ignore', ms(600_200))).toBe(false);
    expect(tv.ok('watch_live', ms(601_000))).toBe(true);
  });

  it('a card she asked for herself is no different: the Light card, the offer her hold brings', () => {
    const light = television();
    light.shows('light-2026-10-13', ms(4_000));
    expect(light.ok('put_out', ms(4_400))).toBe(false);
    expect(light.ok('put_out', ms(5_000))).toBe(true);

    const reach = television();
    reach.shows('reach-1800000004000', ms(4_000));
    expect(reach.ok('ring_me', ms(4_900))).toBe(false);
    expect(reach.ok('ring_me', ms(5_100))).toBe(true);
  });

  it('a page turned under the same card keeps its buttons live: "What Sarah sees" is not made sluggish', () => {
    const tv = television();
    tv.shows('sharing', ms(0));
    expect(tv.ok('next', ms(1_500))).toBe(true);

    // The next page arrives as the same card, a moment later — and again every tick, as the screen is drawn.
    tv.shows('sharing', ms(1_700)).shows('sharing', ms(2_000));
    expect(tv.ok('next', ms(2_050))).toBe(true);
    expect(tv.ok('toggle', ms(2_200))).toBe(true);
  });

  it('a card redrawn, patched or measured again is the same card: only a different one starts the second', () => {
    const settle = pressSettle();
    settle.appeared('door-evt-9', ms(0));
    // The picture arrives, the description arrives, the tick runs: the same card.
    for (const at of [1_000, 2_000, 2_500, 3_000]) settle.appeared('door-evt-9', ms(at));

    expect(settle.acts(ms(3_010))).toBe(true);
  });

  it('a card that leaves and comes back has come on screen again', () => {
    const tv = television();
    tv.shows('note-1', ms(0)).shows(null, ms(60_000)).shows('note-1', ms(120_000));

    expect(tv.ok('reply_1', ms(120_400))).toBe(false);
    expect(tv.ok('reply_1', ms(121_000))).toBe(true);
  });

  it('starts again when Wick comes back on screen: she is looking at it afresh', () => {
    const tv = television();
    tv.shows('tell-d7', ms(0));
    expect(tv.settle.acts(ms(30_000))).toBe(true);

    tv.returns(ms(3_600_000));
    expect(tv.ok('tell', ms(3_600_300))).toBe(false);
    expect(tv.ok('tell', ms(3_601_000))).toBe(true);
  });

  it('has nothing against a press before any card has come on screen, and starts the second with the first that does', () => {
    expect(pressSettle().acts(ms(0))).toBe(true);
    const settle = pressSettle();
    settle.appeared(null, ms(0));
    settle.appeared('tell-d7', ms(10));
    expect(settle.acts(ms(20))).toBe(false);
  });
});

describe('pressSettle — beside the guard for her thumb coming up from a hold', () => {
  it('leaves that guard as it was: the release of the hold is still the one press it takes', () => {
    const tv = television();
    // She holds OK; two seconds in it is a hold; the offer arrives while her thumb is still down.
    tv.hold.held(ms(2_000));
    tv.shows('reach-1', ms(2_600));
    tv.hold.released(ms(5_000));

    // The key coming up is given to the card's first button: "Yes, ask Sarah". It is her thumb.
    expect(tv.ok('ring_me', ms(5_050))).toBe(false);
    // And her own press, after she has read it, is hers.
    expect(tv.ok('ring_me', ms(8_000))).toBe(true);
    expect(tv.sent).toEqual([{ cardId: 'reach-1', action: 'ring_me' }]);
  });

  it('also covers a release the other guard cannot see: the card arrived, and the thumb came up within its first second', () => {
    const tv = television();
    // A remote that never says the key came up: the hold guard gives up after ten seconds.
    tv.shows('reach-1', ms(20_000));

    expect(tv.ok('ring_me', ms(20_400))).toBe(false);
    expect(tv.sent).toEqual([]);
  });
});

describe('one second, on both televisions', () => {
  it('is the very same rule the family’s television uses', () => {
    expect(FAMILY_PRESS_SETTLE_MS).toBe(PRESS_SETTLE_MS);

    const family = pressGuard();
    const resident = pressSettle();
    family.surface('card:ftv-reach-r1:calling', ms(0));
    resident.appeared('reach-1', ms(0));
    for (const at of [0, 300, 999, 1_000, 1_100, 60_000]) expect(family.cardActs(ms(at))).toBe(resident.acts(ms(at)));
  });
});

// The guard is two lines in ResidentApp.tsx. This holds them where they are:
// before anything a press can do.
describe('ResidentApp.tsx — where the rule sits', () => {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../ResidentApp.tsx'), 'utf8');
  const handler = source.slice(source.indexOf('const handleAction = React.useCallback('), source.indexOf('// Back on a waiting card the resident opened'));

  it('asks the guard before a press can open the camera, start a film, remove a card or tell the server', () => {
    const asked = handler.indexOf('settle.acts(');

    expect(asked).toBeGreaterThan(-1);
    for (const does of ['setLiveFor(', 'setWatching(', 'reachAsked.done()', 'store.remove(', "t: 'card_action'"]) {
      expect(handler.indexOf(does), does).toBeGreaterThan(asked);
    }
  });

  it('asks the guard for her thumb first, as before', () => {
    expect(handler.indexOf('guard.swallows(')).toBeGreaterThan(-1);
    expect(handler.indexOf('guard.swallows(')).toBeLessThan(handler.indexOf('settle.acts('));
  });

  it('tells the guard which card is on screen as it is drawn, by the card’s id, and when Wick comes back', () => {
    // The Easier to see card by its own name, when no card from the server is over it.
    expect(source).toMatch(/settle\.appeared\(card\?\.id \?\? \(seeingShown \? SEEING_CARD : null\), Date\.now\(\)\)/);
    expect(source).toMatch(/settle\.returned\(Date\.now\(\)\)/);
  });
});

describe('pressActs — the same second, for anything that came within the remote’s reach at a known moment', () => {
  it('takes no press for a second after it came within reach, and the press after that', () => {
    expect(pressActs(T, ms(0))).toBe(false);
    expect(pressActs(T, ms(317))).toBe(false);
    expect(pressActs(T, ms(PRESS_SETTLE_MS - 1))).toBe(false);
    expect(pressActs(T, ms(PRESS_SETTLE_MS))).toBe(true);
    expect(pressActs(T, ms(60_000))).toBe(true);
  });

  it('takes no press at all while it is not within reach', () => {
    expect(pressActs(null, ms(0))).toBe(false);
    expect(pressActs(null, ms(60_000))).toBe(false);
  });

  it('is not let through by a clock that went back', () => {
    expect(pressActs(T, ms(-5_000))).toBe(false);
  });

  it('is the one rule: a card’s guard answers by it', () => {
    const settle = pressSettle();
    settle.appeared('note-1', T);

    for (const at of [0, 317, 999, 1_000, 5_000]) expect(settle.acts(ms(at)), String(at)).toBe(pressActs(T, ms(at)));
  });
});
