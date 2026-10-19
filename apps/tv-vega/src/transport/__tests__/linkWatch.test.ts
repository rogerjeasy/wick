import { describe, expect, it } from 'vitest';
import { LINK_DOWN_AFTER_MS, linkWatch } from '../linkWatch.js';

describe('linkWatch', () => {
  it('says nothing while the channel is open', () => {
    const watch = linkWatch();
    expect(watch.report(true, 0)).toBe(false);
    expect(watch.report(true, 1_000_000)).toBe(false);
  });

  it('says nothing for a drop that is over before the wait is', () => {
    const watch = linkWatch();
    expect(watch.report(false, 0)).toBe(false);
    expect(watch.report(false, LINK_DOWN_AFTER_MS - 1)).toBe(false);
    expect(watch.report(true, LINK_DOWN_AFTER_MS)).toBe(false);
  });

  it('says it is down once the trouble has been unbroken for the wait', () => {
    const watch = linkWatch();
    watch.report(false, 5_000);
    expect(watch.report(false, 5_000 + LINK_DOWN_AFTER_MS)).toBe(true);
    expect(watch.report(false, 5_000 + 10 * LINK_DOWN_AFTER_MS)).toBe(true);
  });

  it('counts again from the start after a second of being open', () => {
    const watch = linkWatch();
    watch.report(false, 0);
    watch.report(true, 15_000);
    expect(watch.report(false, 16_000)).toBe(false);
    expect(watch.report(false, 16_000 + LINK_DOWN_AFTER_MS - 1)).toBe(false);
    expect(watch.report(false, 16_000 + LINK_DOWN_AFTER_MS)).toBe(true);
  });

  it('stops saying it the moment the channel is open again', () => {
    const watch = linkWatch(1000);
    watch.report(false, 0);
    expect(watch.report(false, 5000)).toBe(true);
    expect(watch.report(true, 5001)).toBe(false);
  });

  it('forgets earlier trouble when a new channel is made', () => {
    const watch = linkWatch(1000);
    watch.report(false, 0);
    watch.reset();
    expect(watch.report(false, 5000)).toBe(false);
  });
});
