/**
 * Her day, as the edge writes it (today.mjs): the date where the house is,
 * her name, and who is coming today and tomorrow — from the roster, on the
 * word of people she still allows, three at most, and never saying anyone
 * came.
 */
import { describe, expect, it } from 'vitest';
import { MAX_COMING, errandPersonId, homeIn, memberPersonId, readHerDay } from '@wick/contracts';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { MAX_COMING as EDGE_MAX_COMING, PERSON_SK_PREFIX, clockWords, herDay, localMoment, rosterRange, startOfLocalDay } from '../today.mjs';

const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';
/** Monday 19 October 2026, 09:15 in London (08:15 UTC). */
const NOW = Date.parse('2026-10-19T08:15:00Z');
const MINUTE = 60_000;

type Row = Record<string, { S?: string; N?: string }>;

const meta = (residentName?: string): Row => ({ sk: { S: 'META' }, ...(residentName ? { residentName: { S: residentName } } : {}) });
const member = (userId: string, status = 'allowed'): Row => ({ sk: { S: `MEM#${userId}` }, status: { S: status } });
const person = (entry: Record<string, unknown>): Row => ({ sk: { S: `${PERSON_SK_PREFIX}${String(entry.personId)}` }, data: { S: JSON.stringify(entry) } });

const regular = (name: string, pattern: string, addedBy?: string) => person({ personId: name.toLowerCase(), name, expectedPattern: pattern, ...(addedBy ? { addedBy } : {}) });
const errand = (who: string, at: number, by = 'u_sarah', byName = 'Sarah Hughes') =>
  person({ personId: errandPersonId('err_aaaaaaaaaaaaaaaaaaaa'), name: who, expectedOnce: { at, windowMin: 60 }, addedBy: by, arrangedByName: byName });
const ownVisit = (userId: string, name: string, at: number) => person({ personId: memberPersonId(userId), name, expectedOnce: { at, windowMin: 60 } });

const day = (rosterRows: Row[], homeRows: Row[] = [meta('Margaret Hill'), member('u_sarah')], now = NOW, timeZone = LONDON) =>
  herDay({ homeRows, rosterRows, now, timeZone });
const lines = (today: { coming: { line: string }[] }) => today.coming.map((c) => c.line);

describe('the day itself', () => {
  it('is dated where the house is, with her first name, and starts and ends at her midnight', () => {
    const today = day([]);
    expect(today).toMatchObject({ weekday: 0, day: 19, month: 9, name: 'Margaret', coming: [] });
    expect(new Date(today.dayStart).toISOString()).toBe('2026-10-18T23:00:00.000Z');
    expect(new Date(today.dayEnd).toISOString()).toBe('2026-10-19T23:00:00.000Z');
    // And is what the contract reads: nothing of it is dropped on the bus.
    expect(readHerDay(JSON.parse(JSON.stringify(today)))).toEqual(today);
  });

  it('is Sunday in New York while it is already Monday in London', () => {
    const late = Date.parse('2026-10-19T02:00:00Z');
    expect(day([], undefined, late, NEW_YORK)).toMatchObject({ weekday: 6, day: 18 });
    expect(day([], undefined, late, LONDON)).toMatchObject({ weekday: 0, day: 19 });
  });

  it('has no name when the household has none, and is still a day', () => {
    const today = day([], [meta()]);
    expect(today.name).toBeUndefined();
    expect(today.day).toBe(19);
  });

  it('knows the day the clocks go back is twenty-five hours long, and the day they go forward twenty-three', () => {
    const autumn = day([], undefined, Date.parse('2026-10-25T12:00:00Z'));
    expect(autumn.dayEnd - autumn.dayStart).toBe(25 * 60 * MINUTE);
    const spring = day([], undefined, Date.parse('2026-03-29T12:00:00Z'));
    expect(spring.dayEnd - spring.dayStart).toBe(23 * 60 * MINUTE);
    expect(startOfLocalDay(Date.parse('2026-10-25T00:30:00Z'), LONDON)).toBe(Date.parse('2026-10-24T23:00:00Z'));
  });

  it('puts a clock time on the right moment of a day the clocks moved, and has no moment for an hour that day skipped', () => {
    const spring = startOfLocalDay(Date.parse('2026-03-29T12:00:00Z'), LONDON);
    expect(localMoment(spring, 9, 0, LONDON)).toBe(Date.parse('2026-03-29T08:00:00Z'));
    expect(localMoment(spring, 1, 30, LONDON)).toBeUndefined();
  });

  it('says a time the way the phrasebook reads one', () => {
    expect(clockWords(Date.parse('2026-10-19T08:00:00Z'), LONDON)).toBe('9 am');
    expect(clockWords(Date.parse('2026-10-19T09:18:00Z'), LONDON)).toBe('10:18 am');
    expect(clockWords(Date.parse('2026-10-19T11:00:00Z'), LONDON)).toBe('12 pm');
    expect(clockWords(Date.parse('2026-10-19T23:05:00Z'), LONDON)).toBe('12:05 am');
  });
});

describe('who is coming', () => {
  it('a regular visitor: today while their time is still to come or under way, and tomorrow once it is over', () => {
    // Monday: Maria comes on Mondays at ten and Tuesdays at nine.
    const maria = regular('Maria', 'MON,TUE 10:00±30m', 'u_sarah');
    expect(lines(day([maria]))).toEqual(['Maria usually comes today at 10 am.']);
    // At 10:29 she may be at the door yet; at 10:31 the window is over and it is tomorrow's visit.
    expect(lines(day([maria], undefined, Date.parse('2026-10-19T09:29:00Z')))).toEqual(['Maria usually comes today at 10 am.']);
    expect(lines(day([maria], undefined, Date.parse('2026-10-19T09:31:00Z')))).toEqual(['Maria usually comes tomorrow at 10 am.']);
  });

  it('a visit somebody arranged: in the member’s own words, said to be expected, with who arranged it', () => {
    const today = day([errand('the window cleaner', Date.parse('2026-10-19T09:18:00Z'))]);
    expect(lines(today)).toEqual(['The window cleaner is expected today at 10:18 am. Sarah arranged it.']);
    // It is said until the visit's window is over, and then not at all.
    expect(today.coming[0]!.until).toBe(Date.parse('2026-10-19T10:18:00Z'));
    expect(lines(day([errand('the window cleaner', Date.parse('2026-10-19T09:18:00Z'))], undefined, Date.parse('2026-10-19T10:19:00Z')))).toEqual([]);
  });

  it('a member’s own visit: they are coming to see her', () => {
    expect(lines(day([ownVisit('u_sarah', 'Sarah Hughes', Date.parse('2026-10-20T14:00:00Z'))]))).toEqual(['Sarah is coming to see you tomorrow at 3 pm.']);
  });

  it('a line about tomorrow is said only until midnight: then it is today’s, and the day is asked for again', () => {
    const today = day([regular('Maria', 'TUE 09:00±30m', 'u_sarah')]);
    expect(lines(today)).toEqual(['Maria usually comes tomorrow at 9 am.']);
    expect(today.coming[0]!.until).toBe(today.dayEnd);
  });

  it('nothing further off than tomorrow, and nothing already over', () => {
    const thursday = regular('Maria', 'THU 09:00±30m', 'u_sarah');
    const later = errand('the plumber', Date.parse('2026-10-21T09:00:00Z'));
    const earlier = errand('the plumber', Date.parse('2026-10-19T06:00:00Z'));
    expect(lines(day([thursday, later, earlier]))).toEqual([]);
  });

  it('in the order they happen, and three at most — never four', () => {
    const roster = [
      regular('Tom', 'TUE 15:00±30m', 'u_sarah'),
      errand('the window cleaner', Date.parse('2026-10-19T09:18:00Z')),
      ownVisit('u_sarah', 'Sarah Hughes', Date.parse('2026-10-19T17:00:00Z')),
      regular('Maria', 'TUE 09:00±30m', 'u_sarah'),
    ];
    expect(lines(day(roster))).toEqual([
      'The window cleaner is expected today at 10:18 am. Sarah arranged it.',
      'Sarah is coming to see you today at 6 pm.',
      'Maria usually comes tomorrow at 9 am.',
    ]);
    expect(EDGE_MAX_COMING).toBe(MAX_COMING);
  });

  it('only on the word of someone she still allows: a visitor vouched for by a member she removed is not hers to expect', () => {
    const roster = [regular('Maria', 'TUE 09:00±30m', 'u_gone'), ownVisit('u_gone', 'Paul', Date.parse('2026-10-19T15:00:00Z')), regular('Ann', 'TUE 11:00±30m')];
    const homeRows = [meta('Margaret'), member('u_sarah'), member('u_gone', 'removed')];
    // Ann was put on the roster by nobody in the family (the household's operator): she stands.
    expect(lines(day(roster, homeRows))).toEqual(['Ann usually comes tomorrow at 11 am.']);
  });

  it('leaves out a row it cannot read, and never throws over one', () => {
    const broken: Row[] = [{ sk: { S: 'PER#x' }, data: { S: '{not json' } }, { sk: { S: 'PER#y' } }, regular('Maria', 'every day at nine', 'u_sarah')];
    expect(lines(day(broken))).toEqual([]);
  });
});

describe('the roster’s one read', () => {
  it('is every PER# row of this household and no other', () => {
    expect(rosterRange({ table: 'wick', householdId: 'hh-1' })).toEqual({
      TableName: 'wick',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': { S: 'HH#hh-1' }, ':prefix': { S: 'PER#' } },
    });
  });
});

describe('her day in Spanish', () => {
  it('says each line in her language when the phrasebook holds it, and leaves the member’s own words whole', () => {
    const today = day([
      errand('the window cleaner', Date.parse('2026-10-19T09:18:00Z')),
      ownVisit('u_sarah', 'Sarah Hughes', Date.parse('2026-10-19T13:00:00Z')),
      regular('Maria', 'TUE 09:00±30m', 'u_sarah'),
    ]);
    const spoken = homeIn('es', { today });
    expect(spoken.today?.coming.map((c) => c.line)).toEqual([
      'The window cleaner is expected today at 10:18 am. Sarah arranged it.',
      'Sarah viene a verle hoy a las 14:00.',
      'Maria suele venir mañana a las 9:00.',
    ]);
    // Only the words change: when each is said until, and the date, are the same.
    expect({ ...spoken.today, coming: [] }).toEqual({ ...today, coming: [] });
    expect(spoken.today?.coming.map((c) => c.until)).toEqual(today.coming.map((c) => c.until));
  });
});
