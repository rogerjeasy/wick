import { describe, expect, it } from 'vitest';
import { WatchTally, counted, orderProgrammes, partOfDay, readTally, type Tally } from '../order.js';

const films = [{ id: 'bbb' }, { id: 'sintel' }, { id: 'tos' }];
const ids = (ordered: readonly { programme: { id: string } }[]) => ordered.map((o) => o.programme.id);
const none = () => 0;

describe('partOfDay', () => {
  it('counts the day as her greeting does', () => {
    expect(partOfDay(0)).toBe('morning');
    expect(partOfDay(11)).toBe('morning');
    expect(partOfDay(12)).toBe('afternoon');
    expect(partOfDay(17)).toBe('afternoon');
    expect(partOfDay(18)).toBe('evening');
    expect(partOfDay(23)).toBe('evening');
  });
});

describe('orderProgrammes — home adapts to her', () => {
  it('keeps the catalogue’s order on a television with no history', () => {
    expect(ids(orderProgrammes(films, { startAt: none, tally: {}, hour: 15 }))).toEqual(['bbb', 'sintel', 'tos']);
  });

  it('puts a film she stopped part-way first, and says where she left it', () => {
    const ordered = orderProgrammes(films, { startAt: (id) => (id === 'tos' ? 120_000 : 0), tally: {}, hour: 15 });
    expect(ids(ordered)).toEqual(['tos', 'bbb', 'sintel']);
    expect(ordered[0]!.resumeAtMs).toBe(120_000);
    expect(ordered[1]!.resumeAtMs).toBeUndefined();
  });

  it('then the films she watches most at this time of day, and only this time of day', () => {
    const tally: Tally = { sintel: { evening: 3 }, tos: { afternoon: 2 } };
    expect(ids(orderProgrammes(films, { startAt: none, tally, hour: 20 }))).toEqual(['sintel', 'bbb', 'tos']);
    expect(ids(orderProgrammes(films, { startAt: none, tally, hour: 14 }))).toEqual(['tos', 'bbb', 'sintel']);
    expect(ids(orderProgrammes(films, { startAt: none, tally, hour: 8 }))).toEqual(['bbb', 'sintel', 'tos']);
  });

  it('keeps a part-way film first however much another is watched', () => {
    const tally: Tally = { sintel: { afternoon: 9 } };
    expect(ids(orderProgrammes(films, { startAt: (id) => (id === 'bbb' ? 90_000 : 0), tally, hour: 15 }))).toEqual(['bbb', 'sintel', 'tos']);
  });
});

describe('the tally', () => {
  it('counts a start at its part of the day, and leaves the rest as it was', () => {
    const once = counted({}, 'bbb', 9);
    const twice = counted(once, 'bbb', 9);
    expect(twice).toEqual({ bbb: { morning: 2 } });
    expect(counted(twice, 'bbb', 21)).toEqual({ bbb: { morning: 2, evening: 1 } });
    expect(once).toEqual({ bbb: { morning: 1 } });
  });

  it('reads only what is a tally: anything else in the store is no history', () => {
    expect(readTally(null)).toEqual({});
    expect(readTally('not json')).toEqual({});
    expect(readTally('[1,2]')).toEqual({});
    expect(readTally('{"bbb":{"morning":2,"noon":4,"evening":-1,"afternoon":1.5}}')).toEqual({ bbb: { morning: 2 } });
  });

  it('is kept in its store, and survives a store that cannot keep it', () => {
    let text: string | null = null;
    const kept = new WatchTally({ read: () => text, write: (t) => (text = t) });
    kept.started('sintel', 19);
    expect(new WatchTally({ read: () => text, write: () => undefined }).get()).toEqual({ sintel: { evening: 1 } });

    const broken = new WatchTally({
      read: () => {
        throw new Error('no disk');
      },
      write: () => {
        throw new Error('no disk');
      },
    });
    broken.started('bbb', 9);
    expect(broken.get()).toEqual({ bbb: { morning: 1 } });
  });
});
