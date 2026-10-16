import { describe, expect, it } from 'vitest';
import { announcer } from '../announce.js';

describe('announcer — each card told to the screen reader once', () => {
  it('announces a card that comes on screen while the reader is on, once', () => {
    const a = announcer();
    expect(a.shown('door-1', true)).toBe(true);
    expect(a.shown('door-1', true)).toBe(false);
    expect(a.shown('door-1', true)).toBe(false);
  });

  it('says nothing while the reader is off, and nothing for nothing on screen', () => {
    const a = announcer();
    expect(a.shown('door-1', false)).toBe(false);
    expect(a.shown(null, true)).toBe(false);
  });

  it('announces the card already on screen when the reader is turned on', () => {
    const a = announcer();
    expect(a.shown('week-1', false)).toBe(false);
    expect(a.shown('week-1', true)).toBe(true);
    expect(a.shown('week-1', true)).toBe(false);
  });

  it('announces a card again when it has left and come back, and the next card at once', () => {
    const a = announcer();
    expect(a.shown('note-1', true)).toBe(true);
    expect(a.shown('door-2', true)).toBe(true);
    expect(a.shown('note-1', true)).toBe(true);
    expect(a.shown(null, true)).toBe(false);
    expect(a.shown('note-1', true)).toBe(true);
  });
});
