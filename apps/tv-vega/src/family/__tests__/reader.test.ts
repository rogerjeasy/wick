import { describe, expect, it } from 'vitest';
import type { FamilyTvCard } from '@wick/contracts';
import { READER_PAGE_LINES, openReader, readerKey, readerPage, turn, type Reading } from '../reader.js';

const WEEK: FamilyTvCard = {
  id: 'ftv-week-2026-W41',
  kind: 'week',
  headline: 'Margaret’s week is ready to read.',
  pages: ['A quiet week.', 'Maria came on Tuesday and Thursday.', 'Most evenings ended with a film.'],
  actions: [
    { id: 'ftv-read', label: 'Read it', kind: 'primary' },
    { id: 'ftv-later', label: 'Later', kind: 'secondary' },
  ],
};
const at = (page: number): Reading => ({ ...openReader(WEEK)!, page });

describe('openReader — the card’s pages, taken as they are when it is opened', () => {
  it('opens at the first page', () => {
    expect(openReader(WEEK)).toEqual({ cardId: WEEK.id, pages: WEEK.pages, page: 0 });
  });

  it('does not open a card that brings nothing to read', () => {
    const { pages: _pages, ...bare } = WEEK;

    expect(openReader(bare)).toBeUndefined();
    expect(openReader({ ...WEEK, pages: [] })).toBeUndefined();
  });
});

describe('readerPage — one page, and quietly where it is among them', () => {
  it('gives the page’s words and "2 of 3"', () => {
    expect(readerPage(at(1))).toEqual({ text: 'Maria came on Tuesday and Thursday.', counter: '2 of 3', last: false });
    expect(readerPage(at(2))).toEqual({ text: 'Most evenings ended with a film.', counter: '3 of 3', last: true });
  });

  it('counts nothing when there is only the one page', () => {
    expect(readerPage(openReader({ ...WEEK, pages: ['A quiet week.'] })!)).toEqual({ text: 'A quiet week.', last: true });
  });
});

describe('turn — OK or Right, Left, Back', () => {
  it('goes on a page, and back a page', () => {
    expect(turn(at(0), 'next')).toEqual({ reading: at(1) });
    expect(turn(at(2), 'previous')).toEqual({ reading: at(1) });
  });

  it('stays on the first page when there is none before it', () => {
    expect(turn(at(0), 'previous')).toEqual({ reading: at(0) });
  });

  it('closes on OK at the last page, and says it was read', () => {
    expect(turn(at(2), 'next')).toEqual({ press: { cardId: WEEK.id, action: 'read' } });
  });

  it('closes on Back at the last page, and says it was read: the end was reached', () => {
    expect(turn(at(2), 'back')).toEqual({ press: { cardId: WEEK.id, action: 'read' } });
  });

  it('closes on Back before the end and says nothing: the card stays for another time', () => {
    expect(turn(at(0), 'back')).toEqual({});
    expect(turn(at(1), 'back')).toEqual({});
  });

  it('says a single page was read however it is left', () => {
    const one = openReader({ ...WEEK, pages: ['A quiet week.'] })!;

    expect(turn(one, 'next').press).toEqual({ cardId: WEEK.id, action: 'read' });
    expect(turn(one, 'back').press).toEqual({ cardId: WEEK.id, action: 'read' });
  });
});

describe('readerKey — Right and Left on the remote', () => {
  it('turns on the key going down, once', () => {
    expect(readerKey({ eventType: 'right', eventKeyAction: 0 })).toBe('next');
    expect(readerKey({ eventType: 'left', eventKeyAction: 0 })).toBe('previous');
    expect(readerKey({ eventType: 'right', eventKeyAction: 1 })).toBeUndefined();
  });

  it('takes a press that comes without its halves as a press', () => {
    expect(readerKey({ eventType: 'right' })).toBe('next');
  });

  it('leaves OK to the page itself, which has the focus, and every other key alone', () => {
    for (const eventType of ['select', 'enter', 'up', 'down', 'playpause', 'skip_forward', 'rewind']) {
      expect(readerKey({ eventType, eventKeyAction: 0 })).toBeUndefined();
    }
  });
});

// The week's pages after the first are a day each: a line for the day, then
// up to four of what happened, joined with line breaks. At most 240
// characters and five lines to a page (the server's rule).
describe('a page with line breaks — a day of her week', () => {
  const DAY = 'Monday 5 October\n10:15 — Maria visited.\n13:40 — Someone was at the door.\n16:05 — Tom rang.\n19:30 — A film in the evening.';
  const day: Reading = { cardId: WEEK.id, pages: ['A quiet week.', DAY], page: 1 };

  /** How many lines a page takes on screen, at a width that is on the narrow side of what the television gives 32pt type. */
  const linesOnScreen = (text: string, charsPerLine = 48): number => text.split('\n').reduce((lines, line) => lines + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);

  it('gives the five lines as five lines: every break is kept, and nothing is run together', () => {
    const page = readerPage(day);

    expect(page.text).toBe(DAY);
    expect(page.text.split('\n')).toHaveLength(5);
    expect(page.text.split('\n')[0]).toBe('Monday 5 October');
  });

  it('opens a card whose pages have line breaks exactly as the server wrote them', () => {
    expect(openReader({ ...WEEK, pages: ['A quiet week.', DAY] })?.pages[1]).toBe(DAY);
  });

  it('shows such a page whole: five lines, with room to spare', () => {
    expect(linesOnScreen(DAY)).toBe(5);
    expect(READER_PAGE_LINES).toBeGreaterThan(5);
  });

  it('shows a prose page of 240 characters whole', () => {
    const prose = 'It was a quiet week at Margaret’s. Maria came on Tuesday and on Thursday, as she usually does. '.repeat(3).slice(0, 240);

    expect(prose).toHaveLength(240);
    expect(linesOnScreen(prose)).toBeLessThanOrEqual(READER_PAGE_LINES);
  });

  it('shows the fullest day the server can write whole: a long first line and four that each run over', () => {
    const fullest = ['Wednesday 30 September, continued', ...Array.from({ length: 4 }, (_, i) => `1${i}:15 — ${'x'.repeat(42)}`)].join('\n');

    expect(fullest.length).toBeLessThanOrEqual(240);
    expect(linesOnScreen(fullest)).toBeLessThanOrEqual(READER_PAGE_LINES);
  });
});
