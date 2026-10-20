import { describe, expect, it } from 'vitest';
import { WORDS } from '../../words/words.js';
import { TOUR_CLOSED, TOUR_STEPS, tourActions, tourAfter } from '../tour.js';

describe('the tour — How Wick works', () => {
  it('shows the door, a note, holding OK, reading aloud, and then says it is over', () => {
    expect(TOUR_STEPS.map((step) => step.kind)).toEqual(['door', 'note', 'hold', 'read', 'done']);
  });

  it('says every step in every language', () => {
    for (const step of TOUR_STEPS) {
      for (const key of [step.headlineKey, step.detailKey, ...(step.exampleKey ? [step.exampleKey] : [])]) {
        expect(WORDS.en[key], key).toBeTruthy();
        expect(WORDS.es[key], key).toBeTruthy();
      }
    }
  });

  it('has three actions at most on any step, and only "Back to the films" on the last', () => {
    for (let i = 0; i < TOUR_STEPS.length; i += 1) expect(tourActions(i).length).toBeLessThanOrEqual(3);
    expect(tourActions(0).map((a) => a.id)).toEqual(['next', 'close']);
    expect(tourActions(TOUR_STEPS.length - 1)).toEqual([{ id: 'close', labelKey: 'tour.done', kind: 'primary' }]);
  });

  it('opens at the first step, moves on with "next", and closes after the last, on "close" and on Back', () => {
    let state = tourAfter(TOUR_CLOSED, 'open');
    expect(state).toEqual({ open: true, index: 0 });
    for (let i = 1; i < TOUR_STEPS.length; i += 1) {
      state = tourAfter(state, 'next');
      expect(state).toEqual({ open: true, index: i });
    }
    expect(tourAfter(state, 'next')).toEqual(TOUR_CLOSED);
    expect(tourAfter({ open: true, index: 1 }, 'close')).toEqual(TOUR_CLOSED);
    expect(tourAfter({ open: true, index: 1 }, 'back')).toEqual(TOUR_CLOSED);
    expect(tourAfter(TOUR_CLOSED, 'next')).toEqual(TOUR_CLOSED);
  });
});
