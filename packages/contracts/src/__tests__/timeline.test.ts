import { describe, expect, it } from 'vitest';
import { oneLinePerMoment } from '../timeline.js';

const NINE = Date.UTC(2026, 9, 13, 9, 0);

describe('oneLinePerMoment — one line for one moment at the door', () => {
  it('keeps the confirmed visit, not the ring and the expected line under it at the same minute', () => {
    const entries = [
      { at: NINE, kind: 'door', summary: 'Someone was at the front door.' },
      { at: NINE + 1_000, kind: 'presence', summary: 'Someone came to the door when Maria was expected.' },
      { at: NINE + 2_000, kind: 'visit', summary: 'Maria came, as confirmed on the television.' },
    ];

    expect(oneLinePerMoment(entries).map((e) => e.kind)).toEqual(['visit']);
  });

  it('keeps "came when expected" over the plain ring when nothing was confirmed', () => {
    expect(oneLinePerMoment([{ at: NINE, kind: 'door' }, { at: NINE, kind: 'presence' }]).map((e) => e.kind)).toEqual(['presence']);
  });

  it('keeps rings at other minutes, and every other kind of entry, in their order', () => {
    const entries = [
      { at: NINE - 60_000, kind: 'door' },
      { at: NINE, kind: 'presence' },
      { at: NINE, kind: 'door' },
      { at: NINE + 30_000, kind: 'deviation' },
      { at: NINE + 120_000, kind: 'door' },
    ];

    expect(oneLinePerMoment(entries)).toEqual([entries[0], entries[1], entries[3], entries[4]]);
  });
});
