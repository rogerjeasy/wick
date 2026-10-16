import { describe, expect, it } from 'vitest';
import { readableForGrounding } from '../grounding.js';

const TZ = 'Europe/London';
// Tuesday 6 October 2026, 10:00 in London (BST) is 09:00 UTC.
const TUESDAY_TEN = Date.UTC(2026, 9, 6, 9, 0);

describe('readableForGrounding — the tools’ answers as the Guardrail can read them', () => {
  it('writes a moment as the day, date and time at the house: "on Tuesday" is then in the facts', () => {
    const text = JSON.stringify({ timeline: [{ at: TUESDAY_TEN, kind: 'visit', summary: 'Maria visited.' }], generatedAt: TUESDAY_TEN });

    const readable = JSON.parse(readableForGrounding(text, TZ)) as { timeline: { at: string }[]; generatedAt: string };

    expect(readable.timeline[0]!.at).toMatch(/^Tuesday 6 October 2026.*10:00$/);
    expect(readable.generatedAt).toMatch(/^Tuesday 6 October 2026/);
  });

  it('writes an ISO week with the Monday it starts on: "the week of 5 October" is then in the facts', () => {
    expect(JSON.parse(readableForGrounding(JSON.stringify({ isoWeek: '2026-W41' }), TZ))).toEqual({ isoWeek: '2026-W41, the week of Monday 5 October 2026' });
    expect(JSON.parse(readableForGrounding(JSON.stringify({ isoWeek: '2027-W01' }), TZ))).toEqual({ isoWeek: '2027-W01, the week of Monday 4 January 2027' });
  });

  it('leaves counts, other numbers and other words as they are', () => {
    const week = { deltas: [{ metric: 'door_events', thisWeek: 6, baseline: 6, zScore: 0.1 }], text: 'Someone came to the front door six times.' };

    expect(JSON.parse(readableForGrounding(JSON.stringify(week), TZ))).toEqual(week);
  });

  it('leaves a tool’s plain sentence, and anything that is not JSON, untouched', () => {
    expect(readableForGrounding('Maria is on her list.', TZ)).toBe('Maria is on her list.');
    expect(readableForGrounding('{not json', TZ)).toBe('{not json');
  });
});
