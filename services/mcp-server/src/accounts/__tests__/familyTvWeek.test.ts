/**
 * Sarah's television, the week: her week once she has read it herself
 * (INV-7), offered to be read a screenful at a time, and put away on this
 * television once it has been.
 */
import { describe, expect, it } from 'vitest';
import { DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { FAMILY_TV_OWN_ACTIONS, FAMILY_TV_PRESSES, MAX_CARD_DETAIL_CHARS, familyTvCardId, type TimelineEntry, type WeekNarrative } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import type { MemoryTable } from '../../__tests__/memoryTable.js';
import { familyWeek } from '../../tools/get_week_narrative.js';
import { WEEK_LOOKUP_KEPT_MS } from '../familyTelevision.js';
import { WEEK_MAX_PAGES, WEEK_PAGE_CHARS, pagesOf, weekPages } from '../familyTvWeek.js';
import { MIN, NOW, PICTURE, bearer, homeOf, householdRequests, keepsRhythmPrivate, litToday, putDoorCard, putFamilyTv, putLook, token, world, type World } from './familyTvWorld.js';

/** NOW is Monday 12 October 2026: the week that has just begun, and the one before it. */
const THIS_WEEK = '2026-W42';
const LAST_WEEK = '2026-W41';
const WEEK_BEFORE = '2026-W40';

const PROSE = 'A quiet week. The door was answered four times, each in the morning. Maria came on Tuesday and on Friday, as she usually does.';

function putWeek(table: MemoryTable, isoWeek: string, over: Partial<WeekNarrative> & { seen?: boolean } = {}): void {
  const { seen = true, ...rest } = over;
  const narrative: WeekNarrative = {
    householdId: 'hh-1',
    isoWeek,
    text: PROSE,
    textSource: 'model',
    deltas: [],
    timeline: [],
    generatedAt: NOW - 60 * MIN,
    ...(seen ? { residentSeenAt: NOW - 30 * MIN } : {}),
    ...rest,
  };
  table.put({ pk: { S: 'HH#hh-1' }, sk: { S: `NARR#${isoWeek}` }, data: { S: JSON.stringify(narrative) } });
}

const weekCardOf = async (w: World, authorization?: string) => (await homeOf(w, authorization)).cards.find((card) => card.kind === 'week');
const tvRow = (table: MemoryTable, deviceId = 'tv-sarah') => table.rows('HH#hh-1').find((row) => row.sk?.S === `FTV#${deviceId}`);
const readPress = (isoWeek: string) => ({ cardId: familyTvCardId('week', isoWeek), action: FAMILY_TV_PRESSES.read });

describe('pagesOf — her week, a screenful at a time', () => {
  const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);

  it('is one page when it fits one', () => {
    expect(pagesOf(PROSE)).toEqual([PROSE]);
  });

  it('is no page at all when there is nothing to read', () => {
    expect(pagesOf('')).toEqual([]);
    expect(pagesOf('  \n\n ')).toEqual([]);
  });

  it('is never more than a card’s worth of words to a page', () => {
    expect(WEEK_PAGE_CHARS).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
  });

  it('breaks at the end of a sentence, and loses not a word', () => {
    const text = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} says a little about one day of the week.`).join(' ');

    const pages = pagesOf(text);

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(WEEK_PAGE_CHARS);
      expect(page).toMatch(/^Sentence number \d+ .*\.$/);
    }
    expect(pages.join(' ')).toBe(text);
  });

  it('keeps a sentence whole on the next page rather than start it at the foot of one', () => {
    const first = 'A'.repeat(200) + '.';
    const second = 'B'.repeat(100) + '.';

    expect(pagesOf(`${first} ${second}`, 240)).toEqual([first, second]);
  });

  it('breaks one very long sentence between words, never inside one', () => {
    const sentence = `${Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ')}.`;

    const pages = pagesOf(sentence);

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.length).toBeGreaterThan(0);
      expect(page.length).toBeLessThanOrEqual(WEEK_PAGE_CHARS);
      expect(page).toBe(page.trim());
    }
    expect(pages.flatMap(words)).toEqual(words(sentence));
  });

  it('leaves a word longer than a page whole, on a page of its own', () => {
    const long = 'x'.repeat(50);

    expect(pagesOf(`Before it. ${long} after it.`, 20)).toEqual(['Before it.', long, 'after it.']);
  });

  it('reads line breaks as spaces, and makes no empty page of them', () => {
    expect(pagesOf('One line.\n\nAnother line.\n')).toEqual(['One line. Another line.']);
  });

  it('does not take the full stop of a title for the end of a sentence', () => {
    const text = `${'A'.repeat(20)}. Mrs. Patel came by. ${'B'.repeat(20)}.`;

    expect(pagesOf(text, 40)).toEqual([`${'A'.repeat(20)}.`, 'Mrs. Patel came by.', `${'B'.repeat(20)}.`]);
  });

  it.each([24, 40, 80, 160, 240])('holds for a page of %i characters: no empty page, no cut word, nothing lost', (max) => {
    const text = `${PROSE} ${PROSE.replace(/\./g, '!')} One more thing was noted, and then another, and then a third thing after that one; it went on.`;

    const pages = pagesOf(text, max);

    for (const page of pages) {
      expect(page.length).toBeGreaterThan(0);
      expect(page).toBe(page.trim());
      if (words(page).length > 1) expect(page.length).toBeLessThanOrEqual(max);
    }
    expect(pages.flatMap(words)).toEqual(words(text));
  });
});

describe('weekPages — the paragraph, then the days', () => {
  /** A moment in the week of 5 October 2026, by London's clock (BST, an hour ahead of UTC). */
  const at = (day: number, hour: number, minute = 0): number => Date.UTC(2026, 9, day, hour - 1, minute);
  const entry = (when: number, summary: string, kind: TimelineEntry['kind'] = 'door'): TimelineEntry => ({ at: when, kind, summary });
  const week = (timeline: TimelineEntry[], text = PROSE): WeekNarrative => ({ householdId: 'hh-1', isoWeek: LAST_WEEK, text, deltas: [], timeline, generatedAt: NOW });
  const DOOR = 'Someone was at the front door.';

  it('is the paragraph alone when nothing is on the timeline', () => {
    expect(weekPages(week([]), 'Europe/London')).toEqual([PROSE]);
  });

  it('gives each day that has something a page: the day first, then what happened in the order it did, with the time where the house is', () => {
    const pages = weekPages(week([entry(at(9, 14, 2), 'Maria visited.', 'visit'), entry(at(5, 10, 15), DOOR), entry(at(5, 16, 40), DOOR), entry(at(6, 9, 5), 'Maria visited.', 'visit')]), 'Europe/London');

    expect(pages).toEqual([
      PROSE,
      `Monday 5 October\n10:15 — ${DOOR}\n16:40 — ${DOOR}`,
      'Tuesday 6 October\n09:05 — Maria visited.',
      'Friday 9 October\n14:02 — Maria visited.',
    ]);
  });

  it('says what the family app says, no more and no less: every entry of the family’s copy, its own sentence unchanged', () => {
    const timeline = [entry(at(5, 10), DOOR, 'door'), entry(at(5, 11), 'Maria visited.', 'visit'), entry(at(5, 12), 'Someone visited.', 'presence'), entry(at(5, 13), 'A card was answered.', 'card'), entry(at(5, 14), 'The morning began later.', 'deviation')];

    const [, monday] = weekPages(week(timeline), 'Europe/London');

    expect(monday!.split('\n')).toEqual(['Monday 5 October', `10:00 — ${DOOR}`, '11:00 — Maria visited.', '12:00 — Someone visited.', '13:00 — A card was answered.']);
    expect(weekPages(week(timeline), 'Europe/London')[2]).toBe('Monday 5 October, continued\n14:00 — The morning began later.');
  });

  it('puts a moment on the day it was where the house is, not where the server is', () => {
    const lateMonday = Date.UTC(2026, 9, 5, 23, 30); // half past midnight on Tuesday, in London

    expect(weekPages(week([entry(lateMonday, DOOR)]), 'Europe/London')[1]).toBe(`Tuesday 6 October\n00:30 — ${DOOR}`);
    expect(weekPages(week([entry(lateMonday, DOOR)]), 'America/New_York')[1]).toBe(`Monday 5 October\n19:30 — ${DOOR}`);
  });

  it('keeps a day together as the house had it: just after midnight there belongs with that morning', () => {
    const justAfterMidnight = Date.UTC(2026, 9, 5, 23, 30); // 00:30 on Tuesday in London, still Monday by UTC

    expect(weekPages(week([entry(justAfterMidnight, DOOR), entry(at(6, 10), 'Maria visited.', 'visit')]), 'Europe/London').slice(1)).toEqual([
      `Tuesday 6 October\n00:30 — ${DOOR}\n10:00 — Maria visited.`,
    ]);
  });

  it('carries a full day on to the next page, and says it is the same day', () => {
    const busy = Array.from({ length: 9 }, (_, i) => entry(at(5, 9 + i), DOOR));

    const pages = weekPages(week(busy), 'Europe/London').slice(1);

    expect(pages.map((page) => page.split('\n')[0])).toEqual(['Monday 5 October', 'Monday 5 October, continued', 'Monday 5 October, continued']);
    expect(pages.flatMap((page) => page.split('\n').slice(1))).toEqual(busy.map((_, i) => `${String(9 + i).padStart(2, '0')}:00 — ${DOOR}`));
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(WEEK_PAGE_CHARS);
      // A card's body is five lines (vega-calm-ui): the day and four things.
      expect(page.split('\n').length).toBeLessThanOrEqual(5);
    }
  });

  it('breaks a page before it is over a card’s worth of characters, not only its lines', () => {
    const long = 'A sentence about the door that goes on for a good deal longer than most of them ever do.';

    const pages = weekPages(week([entry(at(5, 9), long), entry(at(5, 10), long), entry(at(5, 11), long)]), 'Europe/London').slice(1);

    expect(pages).toHaveLength(2);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(WEEK_PAGE_CHARS);
  });

  describe('the television’s twelve pages', () => {
    /** A day of eight things: two pages. */
    const twoPageDay = (day: number): TimelineEntry[] => Array.from({ length: 8 }, (_, i) => entry(at(day, 9 + i), DOOR));
    const twoPagesOfProse = `${'A'.repeat(200)}. ${'B'.repeat(200)}.`;

    it('is the cap the television keeps', () => {
      expect(WEEK_MAX_PAGES).toBe(12);
    });

    it('keeps every day when the week is exactly twelve pages', () => {
      const pages = weekPages(week([5, 6, 7, 8, 9].flatMap(twoPageDay), twoPagesOfProse), 'Europe/London');

      expect(pages).toHaveLength(12);
      expect(pages.at(-1)).toMatch(/^Friday 9 October, continued\n/);
    });

    it('leaves a day out whole rather than go over, and ends with nothing that is not so', () => {
      const pages = weekPages(week([...[5, 6, 7, 8, 9].flatMap(twoPageDay), entry(at(10, 10), 'Maria visited.', 'visit')], twoPagesOfProse), 'Europe/London');

      expect(pages).toHaveLength(12);
      expect(pages.at(-1)).toMatch(/^Friday 9 October, continued\n/);
      expect(pages.join('\n')).not.toMatch(/Saturday|Maria|more|…|\.\.\./);
    });

    it('keeps whole days from the start of the week: a later, shorter day does not take the place of one left out', () => {
      // One page of prose, five two-page days (eleven), then a two-page Saturday that does not fit, then a one-page Sunday that would.
      const pages = weekPages(week([...[5, 6, 7, 8, 9, 10].flatMap(twoPageDay), entry(at(11, 10), 'Maria visited.', 'visit')]), 'Europe/London');

      expect(pages).toHaveLength(11);
      expect(pages.join('\n')).not.toMatch(/Saturday|Sunday/);
    });
  });
});

describe('GET /tv/home — her week', () => {
  it('offers the latest week she has read, saying which week it is and never calling it this one', async () => {
    const w = await world();
    putWeek(w.table, LAST_WEEK);

    const card = await weekCardOf(w);

    expect(card).toEqual({
      id: `ftv-week-${LAST_WEEK}`,
      kind: 'week',
      headline: 'Margaret’s week is here to read.',
      detail: 'The week from Monday 5 October to Sunday 11 October.',
      pages: [PROSE],
      actions: [
        { id: FAMILY_TV_OWN_ACTIONS.read, label: 'Read it', kind: 'primary' },
        { id: FAMILY_TV_OWN_ACTIONS.later, label: 'Not now', kind: 'dismiss' },
      ],
    });
    expect(JSON.stringify(card)).not.toMatch(/this week/i);
  });

  it('gives the week in pages when it is longer than one', async () => {
    const w = await world();
    const long = Array.from({ length: 8 }, (_, i) => `Day ${i + 1} went much as the one before it did, with the door and the post.`).join(' ');
    putWeek(w.table, LAST_WEEK, { text: long });

    const card = await weekCardOf(w);

    expect(card!.pages).toEqual(pagesOf(long));
    expect(card!.pages!.length).toBeGreaterThan(1);
  });

  it('INV-7: shows nothing, and hints at nothing, while the week waits for her to read it first', async () => {
    const none = await world();
    const awaiting = await world();
    putWeek(awaiting.table, THIS_WEEK, { seen: false });

    const home = await homeOf(awaiting);

    expect(home.cards).toEqual([]);
    expect(JSON.stringify(home)).toBe(JSON.stringify(await homeOf(none)));
    expect(JSON.stringify(home)).not.toContain(PROSE);
  });

  it('INV-7: steps over a week still on her television to the latest one she has read', async () => {
    const w = await world();
    putWeek(w.table, THIS_WEEK, { seen: false, text: 'Not hers to have read out yet.' });
    putWeek(w.table, LAST_WEEK);
    putWeek(w.table, WEEK_BEFORE, { text: 'An older week.' });

    const home = await homeOf(w);

    expect(home.cards.map((card) => card.id)).toEqual([`ftv-week-${LAST_WEEK}`]);
    expect(JSON.stringify(home)).not.toContain('Not hers to have read out yet.');
    expect(JSON.stringify(home)).not.toMatch(/this week|waiting|not yet/i);
  });

  it('shows the current week once she has read it', async () => {
    const w = await world();
    putWeek(w.table, THIS_WEEK);
    putWeek(w.table, LAST_WEEK, { text: 'An older week.' });

    expect(await weekCardOf(w)).toMatchObject({ id: `ftv-week-${THIS_WEEK}`, detail: 'The week from Monday 12 October to Sunday 18 October.', pages: [PROSE] });
  });

  it('shows nothing when no week has been written', async () => {
    expect((await homeOf(await world())).cards).toEqual([]);
  });

  it('shows nothing, and does not read her weeks, when she keeps the shape of her week to herself', async () => {
    const w = await world();
    putWeek(w.table, LAST_WEEK);
    keepsRhythmPrivate(w.table);

    const home = await homeOf(w);

    expect(home.cards).toEqual([]);
    expect(JSON.stringify(home)).not.toMatch(/week/i);
    expect(householdRequests(w).some((r) => r.sk.startsWith('NARR#'))).toBe(false);
  });

  it('gives the family’s copy of the week: what she keeps private is not in the pages', async () => {
    const w = await world();
    const narrative: Partial<WeekNarrative> = {
      text: 'Maria came on Tuesday. The door was answered four times.',
      timeline: [
        { at: Date.UTC(2026, 9, 6, 10), kind: 'visit', summary: 'Maria visited', personId: 'maria' },
        { at: Date.UTC(2026, 9, 7, 10), kind: 'door', summary: 'Someone at the door' },
      ],
    };
    putWeek(w.table, LAST_WEEK, narrative);
    w.table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'META' }, residentExclusions: { SS: ['PRESENCE'] } });
    const stored = JSON.parse(w.table.rows('HH#hh-1').find((row) => row.sk?.S === `NARR#${LAST_WEEK}`)!.data!.S!) as WeekNarrative;
    const copy = familyWeek(stored, { ...DEFAULT_POLICY, residentExclusions: ['PRESENCE'] }, 'Europe/London');

    const card = await weekCardOf(w);

    expect(copy.status).toBe('available');
    expect(card!.pages).toEqual([copy.status === 'available' ? copy.narrative.text : '', 'Wednesday 7 October\n11:00 — Someone at the door']);
    expect(JSON.stringify(card)).not.toContain('Maria');
  });

  it('says a simulated week is one', async () => {
    const w = await world({ simulated: true });
    putWeek(w.table, LAST_WEEK, { simulated: true });

    const home = await homeOf(w);

    expect(home.simulated).toBe(true);
    expect(home.cards[0]!.detail).toBe('The week from Monday 5 October to Sunday 11 October. It is a simulated week: this is a demo home.');
  });

  it('ranks below everything that waits for an answer', async () => {
    const w = await world();
    putWeek(w.table, LAST_WEEK);
    putDoorCard(w.table, 'door-abc', { imageRef: PICTURE });
    putLook(w.table, 'door-abc', NOW - 30_000);

    expect((await homeOf(w)).cards.map((card) => card.kind)).toEqual(['door_look', 'week']);
  });
});

describe('GET /tv/home — her weeks are not read on every poll', () => {
  const weekReads = (w: World, from = 0): number => householdRequests(w).slice(from).filter((r) => r.sk.startsWith('NARR#')).length;

  it('looks her weeks up once a minute for a television, however often it asks', async () => {
    const w = await world();
    putWeek(w.table, LAST_WEEK);

    for (let i = 0; i < 7; i += 1) {
      expect(await weekCardOf(w)).toMatchObject({ id: `ftv-week-${LAST_WEEK}` });
      w.clock += 8_000;
    }
    expect(weekReads(w)).toBe(1);

    w.clock = NOW + WEEK_LOOKUP_KEPT_MS;
    await homeOf(w);
    expect(weekReads(w)).toBe(2);
  });

  it('shows a week she has just read on her own television within the minute', async () => {
    const w = await world();
    putWeek(w.table, THIS_WEEK, { seen: false });
    expect(await weekCardOf(w)).toBeUndefined();

    // Ten seconds on she presses OK on her Week card.
    putWeek(w.table, THIS_WEEK);
    w.clock = NOW + 30_000;
    expect(await weekCardOf(w)).toBeUndefined();

    w.clock = NOW + WEEK_LOOKUP_KEPT_MS - 1;
    expect(await weekCardOf(w)).toBeUndefined();
    w.clock = NOW + WEEK_LOOKUP_KEPT_MS;
    expect(await weekCardOf(w)).toMatchObject({ id: `ftv-week-${THIS_WEEK}` });
  });

  it('is a minute', () => {
    expect(WEEK_LOOKUP_KEPT_MS).toBe(60_000);
  });

  it('takes the card away at once when the last page is turned, and looks afresh after', async () => {
    const w = await world();
    putWeek(w.table, LAST_WEEK);
    expect(await weekCardOf(w)).toBeDefined();

    await w.tv.press(bearer(), readPress(LAST_WEEK));
    const from = householdRequests(w).length;

    expect(await weekCardOf(w)).toBeUndefined();
    // Forgotten for this television by the press: the next asking reads her weeks again.
    expect(weekReads(w, from)).toBe(1);
  });

  it('never keeps what she shares: making her week private takes the card away on the very next asking', async () => {
    const w = await world();
    litToday(w.table);
    putWeek(w.table, LAST_WEEK);
    expect(await weekCardOf(w)).toBeDefined();

    keepsRhythmPrivate(w.table);
    w.clock += 8_000;
    const home = await homeOf(w);

    expect(home.cards).toEqual([]);
    expect(home).not.toHaveProperty('light');
  });

  it('never keeps what she shares: visitors made private are out of the pages on the very next asking', async () => {
    const w = await world();
    putWeek(w.table, LAST_WEEK, {
      text: 'Maria came on Tuesday. The door was answered once.',
      timeline: [
        { at: Date.UTC(2026, 9, 6, 10), kind: 'visit', summary: 'Maria visited.', personId: 'maria' },
        { at: Date.UTC(2026, 9, 7, 10), kind: 'door', summary: 'Someone was at the front door.' },
      ],
    });
    expect(JSON.stringify(await weekCardOf(w))).toContain('Maria');

    w.table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'META' }, residentExclusions: { SS: ['PRESENCE'] } });
    w.clock += 8_000;
    const card = await weekCardOf(w);

    expect(JSON.stringify(card)).not.toContain('Maria');
    expect(card!.pages!.at(-1)).toBe('Wednesday 7 October\n11:00 — Someone was at the front door.');
  });

  it('is each television’s own, and a television refused is told nothing kept from before', async () => {
    const w = await world();
    putWeek(w.table, LAST_WEEK);
    putFamilyTv(w.table, { deviceId: 'tv-kitchen' });
    const kitchen = bearer(token({ deviceId: 'tv-kitchen', householdId: 'hh-1', kind: 'family', userId: 'u_sarah' }));

    await homeOf(w);
    await homeOf(w, kitchen);
    expect(weekReads(w)).toBe(2);

    await w.store.setMemberStatus('hh-1', 'u_sarah', 'removed', NOW);
    expect((await w.tv.home(bearer())).status).toBe(403);
  });

  it('looks again when the week turns, whatever was kept', async () => {
    const w = await world();
    // Sunday 18 October, a few seconds before midnight UTC: the last moments of 2026-W42.
    w.clock = Date.UTC(2026, 9, 18, 23, 59, 50);
    putWeek(w.table, LAST_WEEK);
    await homeOf(w);

    w.clock += 20_000;
    await homeOf(w);

    expect(weekReads(w)).toBe(2);
  });
});

describe('POST /tv/press — the week has been read', () => {
  it('is kept on this television’s own row, and the card is not there the next time it asks', async () => {
    const w = await world();
    putWeek(w.table, LAST_WEEK);

    const reply = await w.tv.press(bearer(), readPress(LAST_WEEK));

    expect(reply).toEqual({ status: 200, body: { done: true, say: 'You have read Margaret’s week.' } });
    expect(tvRow(w.table)).toMatchObject({ weekRead: { S: LAST_WEEK }, userId: { S: 'u_sarah' }, denylisted: { BOOL: false } });
    expect(await weekCardOf(w)).toBeUndefined();
  });

  it('is this television’s alone: another of the member’s televisions still offers the week', async () => {
    const w = await world();
    putWeek(w.table, LAST_WEEK);
    putFamilyTv(w.table, { deviceId: 'tv-kitchen' });
    const kitchen = bearer(token({ deviceId: 'tv-kitchen', householdId: 'hh-1', kind: 'family', userId: 'u_sarah' }));

    await w.tv.press(bearer(), readPress(LAST_WEEK));

    expect(await weekCardOf(w)).toBeUndefined();
    expect(await weekCardOf(w, kitchen)).toMatchObject({ id: `ftv-week-${LAST_WEEK}` });
    expect(tvRow(w.table, 'tv-kitchen')?.weekRead).toBeUndefined();
  });

  it('brings the card back when a newer week is there to read, and not before', async () => {
    const w = await world();
    putWeek(w.table, LAST_WEEK);
    await w.tv.press(bearer(), readPress(LAST_WEEK));

    putWeek(w.table, THIS_WEEK, { seen: false });
    expect(await weekCardOf(w)).toBeUndefined();

    // She reads it on her own television; this one is told within the minute it keeps its look-up for.
    putWeek(w.table, THIS_WEEK, { text: 'A new week.' });
    w.clock += WEEK_LOOKUP_KEPT_MS;
    expect(await weekCardOf(w)).toMatchObject({ id: `ftv-week-${THIS_WEEK}`, pages: ['A new week.'] });
  });

  it('can be said twice and is kept once', async () => {
    const w = await world();
    putWeek(w.table, LAST_WEEK);
    await w.tv.press(bearer(), readPress(LAST_WEEK));

    expect((await w.tv.press(bearer(), readPress(LAST_WEEK))).body).toEqual({ done: true, say: 'You have read Margaret’s week.' });
    expect(tvRow(w.table)).toMatchObject({ weekRead: { S: LAST_WEEK } });
  });

  it('changes nothing for a week that is not the one offered', async () => {
    const w = await world();
    putWeek(w.table, LAST_WEEK);
    putWeek(w.table, WEEK_BEFORE);

    const older = await w.tv.press(bearer(), readPress(WEEK_BEFORE));
    const never = await w.tv.press(bearer(), readPress('2026-W30'));

    expect(older).toEqual({ status: 200, body: { done: false, say: 'That week is not here to read.' } });
    expect(never).toEqual(older);
    expect(tvRow(w.table)?.weekRead).toBeUndefined();
    expect(await weekCardOf(w)).toMatchObject({ id: `ftv-week-${LAST_WEEK}` });
  });

  it('INV-7: answers a week still waiting for her exactly as it answers a week that was never written', async () => {
    const awaiting = await world();
    putWeek(awaiting.table, THIS_WEEK, { seen: false });
    const none = await world();

    const pressed = await awaiting.tv.press(bearer(), readPress(THIS_WEEK));

    expect(pressed).toEqual(await none.tv.press(bearer(), readPress(THIS_WEEK)));
    expect(pressed.body).toEqual({ done: false, say: 'That week is not here to read.' });
    expect(tvRow(awaiting.table)?.weekRead).toBeUndefined();
  });

  it('does not let a week be marked read that she keeps to herself', async () => {
    const w = await world();
    putWeek(w.table, LAST_WEEK);
    keepsRhythmPrivate(w.table);

    expect((await w.tv.press(bearer(), readPress(LAST_WEEK))).body).toEqual({ done: false, say: 'That week is not here to read.' });
    expect(tvRow(w.table)?.weekRead).toBeUndefined();
  });

  it('never makes a television’s row: one disconnected in that moment stays disconnected', async () => {
    const w = await world();
    putWeek(w.table, LAST_WEEK);
    w.before((request) => {
      if (request.command === 'UpdateItemCommand' && request.sk === 'FTV#tv-sarah') {
        void w.table.ddb.send(new DeleteItemCommand({ TableName: 'wick', Key: { pk: { S: 'HH#hh-1' }, sk: { S: 'FTV#tv-sarah' } } }));
      }
    });

    const reply = await w.tv.press(bearer(), readPress(LAST_WEEK));

    expect(reply).toEqual({ status: 200, body: { done: false, say: 'This television is no longer connected.' } });
    expect(tvRow(w.table)).toBeUndefined();
  });

  it.each([
    ['a week that is not a week', { cardId: 'ftv-week-latest', action: 'read' }],
    ['a week with something after it', { cardId: 'ftv-week-2026-W41-x', action: 'read' }],
  ])('answers 400 bad_card to %s', async (_name, body) => {
    const w = await world();
    putWeek(w.table, LAST_WEEK);

    expect(await w.tv.press(bearer(), body)).toEqual({ status: 400, body: { error: 'bad_card' } });
    expect(tvRow(w.table)?.weekRead).toBeUndefined();
  });

  it.each([
    ['the television’s own button, which sends nothing', FAMILY_TV_OWN_ACTIONS.read],
    ['an answer to something else', 'known'],
    ['nothing', undefined],
  ])('answers 400 bad_action to %s', async (_name, action) => {
    const w = await world();
    putWeek(w.table, LAST_WEEK);

    expect(await w.tv.press(bearer(), { cardId: familyTvCardId('week', LAST_WEEK), action })).toEqual({ status: 400, body: { error: 'bad_action' } });
    expect(tvRow(w.table)?.weekRead).toBeUndefined();
  });
});
