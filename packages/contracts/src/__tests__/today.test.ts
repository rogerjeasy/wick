import { describe, expect, it } from 'vitest';
import { MAX_COMING, dayIsOver, dayToShow, onThisClock, readHerDay, readHomeState, type HerDay } from '../index.js';

const HOUR = 3_600_000;
const START = Date.parse('2026-10-18T23:00:00Z');
const END = START + 24 * HOUR;

const today: HerDay = {
  weekday: 0,
  day: 19,
  month: 9,
  name: 'Margaret',
  dayStart: START,
  dayEnd: END,
  coming: [
    { line: 'The window cleaner is expected today at 10:18 am. Sarah arranged it.', until: START + 11.3 * HOUR },
    { line: 'Maria usually comes tomorrow at 9 am.', until: END },
  ],
};

describe('readHerDay — her day off the bus or the wire', () => {
  it('keeps a well-formed day whole', () => {
    expect(readHerDay(JSON.parse(JSON.stringify(today)))).toEqual(today);
  });

  it('is nothing at all when the date or the day’s bounds are not a date', () => {
    expect(readHerDay(undefined)).toBeUndefined();
    expect(readHerDay({ ...today, weekday: 7 })).toBeUndefined();
    expect(readHerDay({ ...today, month: 12 })).toBeUndefined();
    expect(readHerDay({ ...today, day: 0 })).toBeUndefined();
    expect(readHerDay({ ...today, dayEnd: START })).toBeUndefined();
    expect(readHerDay({ ...today, dayStart: 'today' })).toBeUndefined();
  });

  it('drops a line that is not one, a name that is not one, and anything past three lines', () => {
    const read = readHerDay({
      ...today,
      name: 'Mar\ngaret',
      coming: [{ line: '', until: END }, { line: 'Fine.', until: 'later' }, ...Array.from({ length: 5 }, (_, i) => ({ line: `Line ${i}.`, until: END }))],
    });
    expect(read?.name).toBeUndefined();
    expect(read?.coming.map((c) => c.line)).toEqual(['Line 0.', 'Line 1.', 'Line 2.']);
    expect(read?.coming).toHaveLength(MAX_COMING);
  });

  it('rides on the home state, and a home without one is as it was', () => {
    expect(readHomeState({ light: 'on', today })).toEqual({ light: 'on', today });
    expect(readHomeState({ light: 'on', today: { weekday: 'Monday' } })).toEqual({ light: 'on' });
  });
});

describe('dayToShow — what the home screen says of her day now', () => {
  it('greets the morning, the afternoon and the evening, counted from her own midnight', () => {
    expect(dayToShow(today, START + 9 * HOUR)?.part).toBe('morning');
    expect(dayToShow(today, START + 12 * HOUR)?.part).toBe('afternoon');
    expect(dayToShow(today, START + 18 * HOUR)?.part).toBe('evening');
  });

  it('says a line only until its time is over', () => {
    expect(dayToShow(today, START + 9 * HOUR)?.coming).toHaveLength(2);
    expect(dayToShow(today, START + 12 * HOUR)?.coming.map((c) => c.line)).toEqual(['Maria usually comes tomorrow at 9 am.']);
  });

  it('says nothing of a day that is over — or not yet begun — and that one is asked for again', () => {
    expect(dayToShow(today, END)).toBeUndefined();
    expect(dayToShow(today, START - 1)).toBeUndefined();
    expect(dayToShow(undefined, START)).toBeUndefined();
    expect(dayIsOver(today, END)).toBe(true);
    expect(dayIsOver(today, END - 1)).toBe(false);
    expect(dayIsOver(undefined, END)).toBe(false);
  });
});

describe('onThisClock — her day on a television whose clock is wrong', () => {
  const told = { ...today, told: START + 19.5 * HOUR };

  it('moves every moment by the gap between the clocks, so the evening is still the evening', () => {
    // The emulator's clock ran eight hours slow: the message arrives, by its clock, at 11:30.
    const slow = START + 11.5 * HOUR;
    const shifted = onThisClock(told, slow)!;
    expect(dayToShow(today, slow)?.part).toBe('morning');
    expect(dayToShow(shifted, slow)?.part).toBe('evening');
    expect(shifted.dayEnd - shifted.dayStart).toBe(today.dayEnd - today.dayStart);
    expect(shifted.coming.map((c) => c.until - shifted.dayStart)).toEqual(today.coming.map((c) => c.until - today.dayStart));
    expect(shifted.told).toBe(slow);
  });

  it('changes nothing for a clock that is right, or a day the server did not stamp', () => {
    expect(onThisClock(told, told.told!)).toEqual(told);
    expect(onThisClock(today, START)).toBe(today);
    expect(onThisClock(undefined, START)).toBeUndefined();
  });

  it('keeps the stamp on the bus', () => {
    expect(readHerDay(JSON.parse(JSON.stringify(told)))?.told).toBe(told.told);
  });
});
