import { describe, it, expect } from 'vitest';
import type { RhythmDelta } from '@wick/contracts';
import { checkComparisons, comparisonLines, comparisonNumbers, comparisonSentences, visibleDeltas } from '../comparisons.js';

const door = (over: Partial<RhythmDelta>): RhythmDelta => ({
  metric: 'door', label: 'the front door', thisWeek: 0, baseline: 0, zScore: 0, baselineWeeks: 0, ...over,
});
const maria = (over: Partial<RhythmDelta>): RhythmDelta => ({
  metric: 'visit:maria', label: 'Maria', thisWeek: 0, baseline: 0, zScore: 0, baselineWeeks: 0, ...over,
});

// Three weeks of history or more: there is a usual week.
const usualDoor = door({ thisWeek: 4, lastWeek: 3, baseline: 4.2, baselineWeeks: 5, zScore: -0.1, verdict: 'usual' });
const usualMaria = maria({ thisWeek: 2, lastWeek: 2, baseline: 2, baselineWeeks: 5, zScore: 0, verdict: 'usual' });
const absentMaria = maria({ thisWeek: 0, lastWeek: 2, baseline: 2, baselineWeeks: 5, zScore: -2, verdict: 'fewer' });
// One week of history: a last week, no usual one.
const youngDoor = door({ thisWeek: 3, lastWeek: 14, baseline: 14, baselineWeeks: 1 });

describe('comparisonLines — the only comparisons the model is shown', () => {
  it('says nothing about last week or usual for a household with no history', () => {
    expect(comparisonLines([door({ thisWeek: 2 })], true)).toEqual([
      'There is not enough history yet to know what a usual week is.',
    ]);
  });

  it('gives last week, but no usual week, from fewer than three weeks', () => {
    expect(comparisonLines([youngDoor], true)).toEqual([
      'Last week: 14 times at the front door.',
      'There is not enough history yet to know what a usual week is.',
    ]);
  });

  it('gives last week, the usual week and the verdict once there are three weeks', () => {
    expect(comparisonLines([usualDoor, usualMaria], true)).toEqual([
      'Last week: 3 times at the front door.',
      'In a usual week: about 4 times at the front door.',
      'The front door this week: about the usual.',
      'Last week: someone came to the door when Maria was expected, 2 times.',
      'In a usual week: someone comes to the door when Maria is expected, about 2 times.',
      'The door when Maria was expected, this week: about the usual.',
      'Nothing unusual this week.',
    ]);
  });

  it('says so in plain words when someone who usually comes did not', () => {
    const lines = comparisonLines([usualDoor, absentMaria], true);

    expect(lines).toContain('Nobody came to the door when Maria was expected this week.');
    expect(lines).toContain('The door when Maria was expected, this week: fewer times than usual.');
    expect(lines).not.toContain('Nothing unusual this week.');
  });

  it('compares a week that is not over with the same point of the weeks before', () => {
    expect(comparisonLines([usualDoor], false)).toEqual([
      'By this point last week: 3 times at the front door.',
      'By this point in a usual week: about 4 times at the front door.',
      'The front door so far this week: about the usual.',
      'Nothing unusual so far this week.',
    ]);
  });

  it('says "nobody" rather than "0 times"', () => {
    const quiet = door({ thisWeek: 0, lastWeek: 0, baseline: 0.2, baselineWeeks: 5, zScore: -0.2, verdict: 'usual' });

    expect(comparisonLines([quiet], true)).toEqual([
      'Last week: nobody came to the front door.',
      'In a usual week: nobody comes to the front door.',
      'The front door this week: about the usual.',
      'Nothing unusual this week.',
    ]);
  });

  it('speaks of a week that is not over in the right tense', () => {
    const quiet = door({ thisWeek: 1, lastWeek: 0, baseline: 0.3, baselineWeeks: 3, zScore: 0.7, verdict: 'usual' });
    const noMaria = maria({ thisWeek: 0, lastWeek: 0, baseline: 1, baselineWeeks: 3, zScore: -1, verdict: 'usual' });
    const someMaria = maria({ thisWeek: 1, lastWeek: 2, baseline: 2, baselineWeeks: 3, zScore: -1, verdict: 'usual' });

    expect(comparisonLines([quiet, noMaria], false)).toEqual([
      'By this point last week: nobody had come to the front door.',
      'By this point in a usual week: nobody has come to the front door.',
      'The front door so far this week: about the usual.',
      'Nobody has come to the door when Maria was expected so far this week.',
      'By this point last week: nobody had come to the door when Maria was expected.',
      'By this point in a usual week: someone has come to the door when Maria is expected, about 1 time.',
      'The door when Maria was expected, so far this week: about the usual.',
      'Nothing unusual so far this week.',
    ]);
    expect(comparisonLines([quiet, someMaria], false)).toContain('By this point last week: someone had come to the door when Maria was expected, 2 times.');
  });

  it('leaves out a visitor who came once, long ago, and is not expected', () => {
    const longAgo = maria({ thisWeek: 0, lastWeek: 0, baseline: 0.17, baselineWeeks: 6, zScore: -0.17, verdict: 'usual' });

    expect(comparisonLines([usualDoor, longAgo], true).join(' ')).not.toMatch(/Maria/);
  });
});

describe('comparisonNumbers', () => {
  it('lets the model use last week and the usual week, and nothing else new', () => {
    expect(comparisonNumbers([usualDoor, absentMaria]).sort()).toEqual([2, 2, 3, 4]);
    expect(comparisonNumbers([youngDoor])).toEqual([14]);
    expect(comparisonNumbers([door({ thisWeek: 2 })])).toEqual([]);
  });
});

describe('checkComparisons — the model never decides what is usual', () => {
  it('rejects "usual" when there is no usual week yet', () => {
    expect(checkComparisons('A usual week, with three callers.', [youngDoor])).toEqual({ ok: false, detail: 'usual' });
    expect(checkComparisons('Nothing out of the ordinary.', [youngDoor])).toEqual({ ok: false, detail: 'ordinary' });
  });

  it('rejects "last week" when last week was not observed', () => {
    expect(checkComparisons('Quieter than last week.', [door({ thisWeek: 1 })])).toEqual({ ok: false, detail: 'last week' });
  });

  it('rejects "nothing unusual" in a week where something was', () => {
    expect(checkComparisons('Nothing unusual this week.', [usualDoor, absentMaria])).toEqual({ ok: false, detail: 'Nothing unusual' });
  });

  it('accepts what the facts support', () => {
    expect(checkComparisons('Someone came four times, about the usual. Nothing unusual this week.', [usualDoor, usualMaria])).toEqual({ ok: true });
    expect(checkComparisons('Three callers, down from 14 last week.', [youngDoor])).toEqual({ ok: true });
    expect(checkComparisons('Maria did not visit, which is unusual for her.', [usualDoor, absentMaria])).toEqual({ ok: true });
  });
});

describe('comparisonSentences — the comparisons, without a model', () => {
  it('says nothing unusual when nothing was', () => {
    expect(comparisonSentences([usualDoor, usualMaria], true)).toEqual(['Nothing unusual this week.']);
    expect(comparisonSentences([usualDoor, usualMaria], false)).toEqual(['Nothing unusual so far this week.']);
  });

  it('leads with whoever usually comes and did not', () => {
    expect(comparisonSentences([usualDoor, absentMaria], true)).toEqual([
      'Nobody came to the door when Maria was expected; usually someone does, about twice a week.',
    ]);
  });

  it('says when the door or a visitor was out of the usual, either way', () => {
    const busyDoor = door({ thisWeek: 12, lastWeek: 4, baseline: 4, baselineWeeks: 4, zScore: 2.4, verdict: 'more' });
    const quietDoor = door({ thisWeek: 0, lastWeek: 4, baseline: 5, baselineWeeks: 4, zScore: -2.5, verdict: 'fewer' });
    const fewerMaria = maria({ thisWeek: 1, lastWeek: 4, baseline: 4, baselineWeeks: 4, zScore: -3, verdict: 'fewer' });
    const moreMaria = maria({ thisWeek: 6, lastWeek: 2, baseline: 2, baselineWeeks: 4, zScore: 4, verdict: 'more' });

    expect(comparisonSentences([busyDoor], true)).toEqual(['The front door had more callers than usual.']);
    expect(comparisonSentences([quietDoor], true)).toEqual(['The front door was quieter than usual.']);
    expect(comparisonSentences([usualDoor, fewerMaria], true)).toEqual(['Usually someone comes to the door when Maria is expected about four times a week.']);
    expect(comparisonSentences([usualDoor, moreMaria], true)).toEqual(['Someone came to the door when Maria was expected more often than usual.']);
  });

  it('speaks of a week that is not over as not over', () => {
    const busyDoor = door({ thisWeek: 12, lastWeek: 4, baseline: 4, baselineWeeks: 4, zScore: 2.4, verdict: 'more' });
    const quietDoor = door({ thisWeek: 0, lastWeek: 4, baseline: 5, baselineWeeks: 4, zScore: -2.5, verdict: 'fewer' });
    const fewerMaria = maria({ thisWeek: 1, lastWeek: 4, baseline: 4, baselineWeeks: 4, zScore: -3, verdict: 'fewer' });
    const moreMaria = maria({ thisWeek: 6, lastWeek: 2, baseline: 2, baselineWeeks: 4, zScore: 4, verdict: 'more' });

    expect(comparisonSentences([usualDoor, absentMaria], false)).toEqual(['Nobody has come to the door when Maria was expected so far; usually someone has, about twice by now.']);
    expect(comparisonSentences([usualDoor, fewerMaria], false)).toEqual(['Usually someone has come to the door when Maria was expected about four times by now.']);
    expect(comparisonSentences([usualDoor, moreMaria], false)).toEqual(['Someone has come to the door when Maria was expected more often than usual so far.']);
    expect(comparisonSentences([busyDoor], false)).toEqual(['The front door has had more callers than usual so far.']);
    expect(comparisonSentences([quietDoor], false)).toEqual(['The front door has been quieter than usual so far.']);
  });

  it('falls back to last week when there is no usual week yet', () => {
    expect(comparisonSentences([youngDoor], true)).toEqual(['Last week it was 14 times.']);
    expect(comparisonSentences([youngDoor], false)).toEqual(['By this point last week it was 14 times.']);
    expect(comparisonSentences([door({ thisWeek: 3, lastWeek: 0, baselineWeeks: 1 })], true)).toEqual(['Last week nobody came.']);
  });

  it('can leave out the verdict on the whole week, for when part of the week is not being told', () => {
    expect(comparisonSentences([usualDoor, usualMaria], true, { wholeWeek: false })).toEqual([]);
    expect(comparisonSentences([usualDoor, absentMaria], true, { wholeWeek: false })).toEqual([
      'Nobody came to the door when Maria was expected; usually someone does, about twice a week.',
    ]);
  });

  it('says nothing at all with no history', () => {
    expect(comparisonSentences([door({ thisWeek: 2 })], true)).toEqual([]);
  });
});

describe('visibleDeltas — what the family may be told when the resident keeps part of the week private', () => {
  it('drops the door, or the visitors, with whatever is hidden', () => {
    expect(visibleDeltas([usualDoor, usualMaria], { door: true, visits: false })).toEqual([usualMaria]);
    expect(visibleDeltas([usualDoor, usualMaria], { door: false, visits: true })).toEqual([usualDoor]);
    expect(visibleDeltas([usualDoor, usualMaria], { door: false, visits: false })).toEqual([usualDoor, usualMaria]);
  });
});

describe('a week with days the doorbell was not heard', () => {
  it('leaves out every comparison an absence would make, and never says nothing was unusual', () => {
    expect(comparisonLines([usualDoor, absentMaria], true, true)).not.toEqual(expect.arrayContaining([expect.stringMatching(/fewer|Nobody came/)]));
    expect(comparisonLines([usualDoor, usualMaria], true, true)).not.toContain('Nothing unusual this week.');
    expect(comparisonSentences([usualDoor, absentMaria], true, { unheard: true })).toEqual([]);
    expect(comparisonSentences([usualDoor, usualMaria], true, { unheard: true })).toEqual([]);
  });
});
