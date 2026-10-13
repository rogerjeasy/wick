import { describe, expect, it } from 'vitest';
import type { DeviceEvent } from '@wick/contracts';
import { ASK_SEND_WITHIN_MS, asking, worthSending } from '../asked.js';
import { LIGHT_ANSWER_WAIT_MS } from '../light.js';

const T = 1_800_000_000_000;
const s = (seconds: number): number => T + seconds * 1000;

// Seen on the Vega simulator, 2026-10-13, after a forced stop and a
// relaunch: she held OK, the server offered to ask someone to ring her, and
// nothing came on screen. The television's channel was not open yet when she
// held the button; her question left late, and the fifteen seconds an answer
// is waited for had been counted from her press — so by the time the offer
// came, it was put away as one she had not asked for.
describe('asking — the wait for the answer to something she asked for', () => {
  it('waits for nothing she has not asked', () => {
    expect(asking().waiting(T)).toBe(false);
  });

  it('counts the wait from when her question left the television, not from her press', () => {
    const hold = asking();
    hold.asked(s(0));

    // The channel opens twenty seconds later, and the question leaves then.
    expect(hold.waiting(s(20))).toBe(true);
    hold.sent(s(0), s(20));

    // The offer comes a second after that — twenty-one seconds after her hold — and is hers.
    expect(hold.waiting(s(21))).toBe(true);
  });

  it('takes an answer that comes while her question has not left yet as her answer', () => {
    const hold = asking();
    hold.asked(s(0));

    expect(hold.waiting(s(1))).toBe(true);
    expect(hold.waiting(s(40))).toBe(true);
  });

  it('waits fifteen seconds once the question has left, as before, and no longer', () => {
    const hold = asking();
    hold.asked(s(0));
    hold.sent(s(0), s(2));

    expect(hold.waiting(s(2) + LIGHT_ANSWER_WAIT_MS - 1)).toBe(true);
    // Sixteen seconds after it left: put away, as today.
    expect(hold.waiting(s(2) + 16_000)).toBe(false);
    expect(hold.waiting(s(2) + LIGHT_ANSWER_WAIT_MS)).toBe(false);
  });

  it('forgets a question that could not leave within a minute of her press: an answer long after is worse than none', () => {
    const hold = asking();
    hold.asked(s(0));

    expect(ASK_SEND_WITHIN_MS).toBe(60_000);
    expect(hold.waiting(s(0) + ASK_SEND_WITHIN_MS - 1)).toBe(true);
    expect(hold.waiting(s(0) + ASK_SEND_WITHIN_MS)).toBe(false);
    // And it stays forgotten, even if something then claims it left.
    hold.sent(s(0), s(61));
    expect(hold.waiting(s(62))).toBe(false);
  });

  it('is over when she has had her answer, or let it go', () => {
    const hold = asking();
    hold.asked(s(0));
    hold.sent(s(0), s(1));
    hold.done();

    expect(hold.waiting(s(2))).toBe(false);
  });

  describe('two holds', () => {
    it('waits for the second: the first leaving does not start the second one’s fifteen seconds', () => {
      const hold = asking();
      hold.asked(s(0));
      hold.asked(s(10));

      // The channel opens at 30 s; the first question leaves, then the second.
      hold.sent(s(0), s(30));
      expect(hold.waiting(s(50))).toBe(true);
      hold.sent(s(10), s(30.5));

      expect(hold.waiting(s(30.5) + LIGHT_ANSWER_WAIT_MS - 1)).toBe(true);
      expect(hold.waiting(s(30.5) + LIGHT_ANSWER_WAIT_MS)).toBe(false);
    });

    it('counts the minute for leaving from the second press', () => {
      const hold = asking();
      hold.asked(s(0));
      hold.asked(s(50));

      expect(hold.waiting(s(70))).toBe(true);
      expect(hold.waiting(s(50) + ASK_SEND_WITHIN_MS)).toBe(false);
    });

    it('starts afresh after an answered one', () => {
      const hold = asking();
      hold.asked(s(0));
      hold.sent(s(0), s(1));
      hold.done();
      hold.asked(s(100));

      expect(hold.waiting(s(101))).toBe(true);
      hold.sent(s(100), s(102));
      expect(hold.waiting(s(102) + LIGHT_ANSWER_WAIT_MS)).toBe(false);
    });
  });
});

describe('worthSending — a question is not sent long after it was asked', () => {
  const reach = (at: number): DeviceEvent => ({ t: 'reach', at });
  const light = (at: number): DeviceEvent => ({ t: 'light', at });

  it('sends her hold, and her press on the light, while they are under a minute old', () => {
    expect(worthSending(reach(s(0)), s(0))).toBe(true);
    expect(worthSending(reach(s(0)), s(0) + ASK_SEND_WITHIN_MS - 1)).toBe(true);
    expect(worthSending(light(s(0)), s(20))).toBe(true);
  });

  it('drops them at a minute: the server would answer as if she had just asked', () => {
    expect(worthSending(reach(s(0)), s(0) + ASK_SEND_WITHIN_MS)).toBe(false);
    expect(worthSending(light(s(0)), s(0) + ASK_SEND_WITHIN_MS)).toBe(false);
    expect(worthSending(reach(s(0)), s(3600))).toBe(false);
  });

  it('agrees with the wait to the millisecond: a question is never sent after its hold was forgotten, nor forgotten while it may still be sent', () => {
    for (const late of [ASK_SEND_WITHIN_MS - 1, ASK_SEND_WITHIN_MS, ASK_SEND_WITHIN_MS + 1]) {
      const hold = asking();
      hold.asked(s(0));
      expect(hold.waiting(s(0) + late)).toBe(worthSending(reach(s(0)), s(0) + late));
    }
  });

  it('never drops anything else, however old: what she watched, what she answered, what was shown', () => {
    const old: DeviceEvent[] = [
      { t: 'card_action', cardId: 'c1', action: 'dismiss', at: s(0) },
      { t: 'card_shown', cardId: 'c1', at: s(0) },
      { t: 'app_lifecycle', state: 'fg', at: s(0) },
      { t: 'break_state', state: 'AT_BREAK', at: s(0) },
      { t: 'playback', state: 'PLAYING', positionMs: 0, durationMs: 1, contentId: 'p', at: s(0) },
    ];

    for (const event of old) expect(worthSending(event, s(24 * 3600))).toBe(true);
  });

  it('does not drop a question for a clock that went backwards', () => {
    expect(worthSending(reach(s(100)), s(0))).toBe(true);
  });
});
