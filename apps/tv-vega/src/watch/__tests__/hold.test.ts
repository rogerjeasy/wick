import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_MS, okHold } from '../hold.js';

const down = (eventType: string) => ({ eventType, eventKeyAction: 0 });
const up = (eventType: string) => ({ eventType, eventKeyAction: 1 });

describe('okHold — holding OK for two seconds', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const watching = (canHold = () => true) => {
    const onHold = vi.fn();
    return { onHold, hold: okHold({ onHold, canHold }) };
  };

  it('is a hold once OK has been down for two seconds, and only once however long it stays down', () => {
    const { hold, onHold } = watching();

    hold.onEvent(down('select'));
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(onHold).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onHold).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10 * HOLD_MS);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it('is not one when the key comes up first: that was a press', () => {
    const { hold, onHold } = watching();

    hold.onEvent(down('select'));
    vi.advanceTimersByTime(HOLD_MS - 1);
    hold.onEvent(up('select'));
    vi.advanceTimersByTime(HOLD_MS);

    expect(onHold).not.toHaveBeenCalled();
  });

  it('knows OK by the name the Vega Virtual Device sends as well', () => {
    const { hold, onHold } = watching();
    hold.onEvent(down('enter'));
    vi.advanceTimersByTime(HOLD_MS);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it('counts from the first moment the key went down, not from each repeat a held key sends', () => {
    const { hold, onHold } = watching();

    hold.onEvent(down('select'));
    for (let t = 0; t < HOLD_MS - 100; t += 100) {
      vi.advanceTimersByTime(100);
      hold.onEvent(down('select'));
    }
    vi.advanceTimersByTime(100);

    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it('says whether the press now ending was a hold, so its release is not taken for a press', () => {
    const { hold } = watching();

    hold.onEvent(down('select'));
    expect(hold.held()).toBe(false);
    vi.advanceTimersByTime(HOLD_MS);
    expect(hold.held()).toBe(true);
    hold.onEvent(up('select'));
    expect(hold.held()).toBe(false);
  });

  it('says when a hold is let go — and says nothing when what was let go was only a press', () => {
    const onHold = vi.fn();
    const onRelease = vi.fn();
    const hold = okHold({ onHold, onRelease, canHold: () => true });

    hold.onEvent(down('select'));
    hold.onEvent(up('select'));
    expect(onRelease).not.toHaveBeenCalled();

    hold.onEvent(down('select'));
    vi.advanceTimersByTime(HOLD_MS + 1_500);
    expect(onRelease).not.toHaveBeenCalled();
    hold.onEvent(up('select'));
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('is never any other key, and another key pressed meanwhile ends it', () => {
    const { hold, onHold } = watching();

    hold.onEvent(down('playpause'));
    vi.advanceTimersByTime(HOLD_MS);
    expect(onHold).not.toHaveBeenCalled();

    hold.onEvent(down('select'));
    vi.advanceTimersByTime(HOLD_MS / 2);
    hold.onEvent(down('right'));
    vi.advanceTimersByTime(HOLD_MS);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('is not begun while the remote belongs to something else — a card on screen, the door camera', () => {
    let free = false;
    const { hold, onHold } = watching(() => free);

    hold.onEvent(down('select'));
    vi.advanceTimersByTime(HOLD_MS);
    expect(onHold).not.toHaveBeenCalled();

    hold.onEvent(up('select'));
    free = true;
    hold.onEvent(down('select'));
    vi.advanceTimersByTime(HOLD_MS);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it('cannot be told from a press on a remote that does not say when a key comes up — so it is never guessed', () => {
    const { hold, onHold } = watching();
    hold.onEvent({ eventType: 'select' });
    vi.advanceTimersByTime(10 * HOLD_MS);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('is forgotten when the screen goes', () => {
    const { hold, onHold } = watching();
    hold.onEvent(down('select'));
    hold.cancel();
    vi.advanceTimersByTime(HOLD_MS);
    expect(onHold).not.toHaveBeenCalled();
  });
});
