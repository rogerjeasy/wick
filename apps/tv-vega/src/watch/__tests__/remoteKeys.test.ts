import { describe, expect, it } from 'vitest';
import { SEEK_STEP_MS, seekTarget, watchCommand } from '../remoteKeys.js';

const press = (eventType: string) => ({ eventType, eventKeyAction: 0 });
const release = (eventType: string) => ({ eventType, eventKeyAction: 1 });

describe('watchCommand', () => {
  it('toggles play and pause on Play/Pause and on OK', () => {
    expect(watchCommand(press('playpause'), { cardVisible: false })).toBe('toggle');
    expect(watchCommand(press('select'), { cardVisible: false })).toBe('toggle');
  });

  it('seeks with the skip keys and with left and right', () => {
    expect(watchCommand(press('skip_forward'), { cardVisible: false })).toBe('forward');
    expect(watchCommand(press('right'), { cardVisible: false })).toBe('forward');
    expect(watchCommand(press('skip_backward'), { cardVisible: false })).toBe('back');
    expect(watchCommand(press('left'), { cardVisible: false })).toBe('back');
  });

  it('understands the names the Vega Virtual Device really sends — not the ones the SDK documents', () => {
    // Seen in the device log, 2026-10-02: KEY_PLAYPAUSE arrives as "play",
    // KEY_ENTER as "enter", KEY_FASTFORWARD as "forward" (FRICTION.md FL-021).
    expect(watchCommand(press('play'), { cardVisible: false })).toBe('toggle');
    expect(watchCommand(press('enter'), { cardVisible: false })).toBe('toggle');
    expect(watchCommand(press('forward'), { cardVisible: false })).toBe('forward');
    expect(watchCommand(press('rewind'), { cardVisible: false })).toBe('back');
    expect(watchCommand(press('enter'), { cardVisible: true })).toBeUndefined();
    expect(watchCommand(press('play'), { cardVisible: true })).toBe('toggle');
  });

  it('acts once per press — on key down, not again on key up', () => {
    expect(watchCommand(release('playpause'), { cardVisible: false })).toBeUndefined();
  });

  it('leaves OK and the arrows to a card that is on screen', () => {
    expect(watchCommand(press('select'), { cardVisible: true })).toBeUndefined();
    expect(watchCommand(press('left'), { cardVisible: true })).toBeUndefined();
    expect(watchCommand(press('right'), { cardVisible: true })).toBeUndefined();
  });

  it('still obeys the dedicated media keys while a card is on screen', () => {
    expect(watchCommand(press('playpause'), { cardVisible: true })).toBe('toggle');
    expect(watchCommand(press('skip_forward'), { cardVisible: true })).toBe('forward');
  });

  it('ignores keys it has no use for', () => {
    expect(watchCommand(press('up'), { cardVisible: false })).toBeUndefined();
    expect(watchCommand(press('menu'), { cardVisible: false })).toBeUndefined();
  });
});

describe('seekTarget', () => {
  it('moves by one step', () => {
    expect(seekTarget(60_000, 'forward', 600_000)).toBe(60_000 + SEEK_STEP_MS);
    expect(seekTarget(60_000, 'back', 600_000)).toBe(60_000 - SEEK_STEP_MS);
  });

  it('never seeks before the start', () => {
    expect(seekTarget(5_000, 'back', 600_000)).toBe(0);
  });

  it('stops just short of the end, so the programme ends by playing rather than by a jump', () => {
    expect(seekTarget(595_000, 'forward', 600_000)).toBe(599_000);
  });

  it('does not clamp to an unknown duration', () => {
    expect(seekTarget(60_000, 'forward', 0)).toBe(60_000 + SEEK_STEP_MS);
  });
});
