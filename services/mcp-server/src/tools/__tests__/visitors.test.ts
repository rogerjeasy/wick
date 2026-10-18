import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { padTimestamp, type RosterEntry } from '@wick/contracts';
import { createMemoryTable, type MemoryTable } from '../../__tests__/memoryTable.js';
import { loadVisitors, registerListRegularVisitors } from '../list_regular_visitors.js';
import { EXPECT_VISIT_PAST_TEXT, EXPECT_VISIT_TOO_FAR_TEXT, registerExpectVisit } from '../expect_visit.js';
import { localToUtc, resolveDay } from '../when.js';
import { registerDidVisitorCome } from '../did_visitor_come.js';
import { DAY_NOT_A_DATE_TEXT, DAY_NOT_YET_TEXT, DAY_TOO_OLD_TEXT, registerGetToday } from '../get_today.js';
import { FAMILY_REFUSAL_TEXT, registerGetResidentSharedView } from '../get_resident_shared_view.js';
import { allowedContext } from './toolContext.js';

const HH = 'hh-1';
// Tuesday 13 October 2026, 12:00 UTC.
const NOW = new Date(Date.UTC(2026, 9, 13, 12));
const MARIA: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' };

const person = (table: MemoryTable, sk: string, entry: RosterEntry) =>
  table.put({ pk: { S: `HH#${HH}` }, sk: { S: sk }, data: { S: JSON.stringify(entry) } });
const visit = (table: MemoryTable, at: number, entry: RosterEntry) =>
  table.put({ pk: { S: `HH#${HH}` }, sk: { S: `EVT#${padTimestamp(at)}#v-${at}` }, type: { S: 'presence' }, personId: { S: entry.personId }, personName: { S: entry.name } });

async function connect(table: MemoryTable, register: (server: McpServer) => void) {
  const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
  register(mcpServer);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}
const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;

describe('loadVisitors — who comes to this house, in words', () => {
  it('names each regular visitor, the days they come, and when they last did', async () => {
    const table = createMemoryTable();
    person(table, 'PER#maria', MARIA);
    visit(table, Date.UTC(2026, 9, 9, 9, 5), MARIA);
    visit(table, Date.UTC(2026, 9, 13, 8, 55), MARIA);

    expect(await loadVisitors(table.ddb, HH, NOW, 'Europe/London')).toEqual({
      visitors: [{ personId: 'maria', name: 'Maria', usualDays: 'Tuesday and Friday mornings', expectedToday: true, lastVisitAt: Date.UTC(2026, 9, 13, 8, 55) }],
      expected: [],
    });
  });

  it('says nothing about a last visit it has no record of', async () => {
    const table = createMemoryTable();
    person(table, 'PER#maria', MARIA);

    const [maria] = (await loadVisitors(table.ddb, HH, new Date(Date.UTC(2026, 9, 14, 12)), 'Europe/London')).visitors;

    expect(maria).toEqual({ personId: 'maria', name: 'Maria', usualDays: 'Tuesday and Friday mornings', expectedToday: false });
  });

  it('lists a visit somebody has announced until it is over, and never after', async () => {
    const table = createMemoryTable();
    const at = Date.UTC(2026, 9, 17, 14);
    person(table, 'PER#member-u_sarah#2026-10-17', { personId: 'member-u_sarah', name: 'Sarah', expectedOnce: { at, windowMin: 60 } });
    person(table, 'PER#member-u_tom#2026-10-10', { personId: 'member-u_tom', name: 'Tom', expectedOnce: { at: Date.UTC(2026, 9, 10, 14), windowMin: 60 } });

    table.put({ pk: { S: `HH#${HH}` }, sk: { S: 'MEM#u_sarah' }, status: { S: 'allowed' } });
    table.put({ pk: { S: `HH#${HH}` }, sk: { S: 'MEM#u_tom' }, status: { S: 'allowed' } });

    expect(await loadVisitors(table.ddb, HH, NOW, 'Europe/London')).toEqual({ visitors: [], expected: [{ name: 'Sarah', at }] });
  });

  it('never lists a visit announced by someone who has since been removed from the circle', async () => {
    const table = createMemoryTable();
    person(table, 'PER#member-u_tom#2026-10-17', { personId: 'member-u_tom', name: 'Tom', expectedOnce: { at: Date.UTC(2026, 9, 17, 14), windowMin: 60 } });
    table.put({ pk: { S: `HH#${HH}` }, sk: { S: 'MEM#u_tom' }, status: { S: 'removed' } });

    expect((await loadVisitors(table.ddb, HH, NOW, 'Europe/London')).expected).toEqual([]);
  });
});

describe('list_regular_visitors (end to end through the registered tool)', () => {
  it('answers in text and as structured content, and is marked read-only', async () => {
    const table = createMemoryTable();
    person(table, 'PER#maria', MARIA);
    const client = await connect(table, (s) => registerListRegularVisitors(s, table.ddb, allowedContext(HH), () => NOW));

    const { tools } = await client.listTools();
    const result = await client.callTool({ name: 'list_regular_visitors', arguments: {} });

    expect(tools[0]!.annotations).toMatchObject({ readOnlyHint: true });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
    expect(result.structuredContent).toMatchObject({ visitors: [{ personId: 'maria', name: 'Maria' }] });
  });

  it('declines when the resident keeps who visits to themselves', async () => {
    const table = createMemoryTable();
    person(table, 'PER#maria', MARIA);
    table.put({ pk: { S: `HH#${HH}` }, sk: { S: 'META' }, residentExclusions: { SS: ['PRESENCE'] } });
    const client = await connect(table, (s) => registerListRegularVisitors(s, table.ddb, allowedContext(HH), () => NOW));

    const result = await client.callTool({ name: 'list_regular_visitors', arguments: {} });

    expect(textOf(result)).toBe(FAMILY_REFUSAL_TEXT);
    expect(result.structuredContent).toEqual({ say: FAMILY_REFUSAL_TEXT });
  });
});

describe('localToUtc — "Saturday at three" is three o’clock where the house is', () => {
  it('reads a summer time in London as an hour ahead of UTC, and a winter one as UTC', () => {
    expect(localToUtc('2026-10-17', '15:00', 'Europe/London')).toBe(Date.UTC(2026, 9, 17, 14));
    expect(localToUtc('2026-11-07', '15:00', 'Europe/London')).toBe(Date.UTC(2026, 10, 7, 15));
  });

  it('is nothing for a date or a time that is not one', () => {
    expect(localToUtc('2026-13-40', '15:00', 'Europe/London')).toBeUndefined();
    expect(localToUtc('2026-10-17', '25:00', 'Europe/London')).toBeUndefined();
  });
});

describe('expect_visit — "tell the door I am coming on Saturday at three"', () => {
  const sarah = allowedContext(HH, { userId: 'u_sarah', name: 'Sarah' });
  const call = async (table: MemoryTable, args: Record<string, string>) => {
    const client = await connect(table, (s) => registerExpectVisit(s, table.ddb, sarah, () => NOW));
    return client.callTool({ name: 'expect_visit', arguments: args });
  };

  it('files the visit under the person who is signed in, at the house’s own time, for the door to match', async () => {
    const table = createMemoryTable();
    person(table, 'PER#maria', MARIA);

    const result = await call(table, { date: '2026-10-17', time: '15:00' });

    const at = Date.UTC(2026, 9, 17, 14);
    const [row] = table.rows(`HH#${HH}`).filter((i) => i.sk!.S!.startsWith('PER#member-'));
    expect(row!.sk!.S).toBe('PER#member-u_sarah#2026-10-17');
    expect(JSON.parse(row!.data!.S!)).toEqual({ personId: 'member-u_sarah', name: 'Sarah', expectedOnce: { at, windowMin: 60 } });
    // Gone by itself two days after the visit.
    expect(row!.ttl!.N).toBe(String(Math.floor((at + 2 * 86_400_000) / 1000)));
    expect(result.structuredContent).toEqual({ expected: true, name: 'Sarah', at, windowMinutes: 60, alsoExpectedThatDay: [] });
  });

  it('says who else usually comes that day', async () => {
    const table = createMemoryTable();
    person(table, 'PER#maria', MARIA);

    const result = await call(table, { date: '2026-10-16', time: '11:00' });

    expect(result.structuredContent).toMatchObject({ alsoExpectedThatDay: ['Maria'] });
  });

  it('does not name the regular visitors to someone the resident keeps them from', async () => {
    const table = createMemoryTable();
    person(table, 'PER#maria', MARIA);
    table.put({ pk: { S: `HH#${HH}` }, sk: { S: 'META' }, residentExclusions: { SS: ['PRESENCE'] } });

    const result = await call(table, { date: '2026-10-16', time: '11:00' });

    // The visit is still announced: that is the member's own news. Who else comes is not theirs to be told.
    expect(result.structuredContent).toMatchObject({ expected: true, alsoExpectedThatDay: [] });
    expect(textOf(result)).not.toContain('Maria');
  });

  it('takes no name from the request: nobody can announce a visit as somebody else', async () => {
    const table = createMemoryTable();

    await call(table, { date: '2026-10-17', time: '15:00', name: 'Maria', personId: 'maria' });

    expect(table.rows(`HH#${HH}`).map((i) => i.sk!.S)).toEqual(['PER#member-u_sarah#2026-10-17']);
  });

  it('refuses a time that has passed, or one too far off to mean anything, and writes nothing', async () => {
    const table = createMemoryTable();

    expect(textOf(await call(table, { date: '2026-10-12', time: '15:00' }))).toBe(EXPECT_VISIT_PAST_TEXT);
    expect(textOf(await call(table, { date: '2027-03-01', time: '15:00' }))).toBe(EXPECT_VISIT_TOO_FAR_TEXT);
    expect(table.rows(`HH#${HH}`)).toEqual([]);
  });
});

describe('get_today — any recent day, not only this one', () => {
  const door = (table: MemoryTable, at: number) =>
    table.put({ pk: { S: `HH#${HH}` }, sk: { S: `EVT#${padTimestamp(at)}#d-${at}` }, type: { S: 'door' } });
  const call = async (table: MemoryTable, args: Record<string, string> = {}) => {
    const client = await connect(table, (s) => registerGetToday(s, table.ddb, allowedContext(HH), () => NOW));
    return client.callTool({ name: 'get_today', arguments: args });
  };

  it('answers for today when no day is named, and says which day that is', async () => {
    const table = createMemoryTable();
    door(table, Date.UTC(2026, 9, 13, 10));
    door(table, Date.UTC(2026, 9, 12, 10));

    const result = await call(table);

    expect(result.structuredContent).toEqual({
      date: '2026-10-13',
      dayInWords: 'Tuesday 13 October 2026',
      events: [{ at: Date.UTC(2026, 9, 13, 10), summary: 'Someone was at the front door.' }],
      keptPrivate: [],
    });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it('answers for the day that was named', async () => {
    const table = createMemoryTable();
    door(table, Date.UTC(2026, 9, 13, 10));
    door(table, Date.UTC(2026, 9, 12, 10));

    expect((await call(table, { date: '2026-10-12' })).structuredContent).toMatchObject({
      date: '2026-10-12',
      events: [{ at: Date.UTC(2026, 9, 12, 10) }],
    });
  });

  it('says so, rather than answering with nothing, for a day that has not come or is too long ago', async () => {
    const table = createMemoryTable();

    expect(textOf(await call(table, { date: '2026-10-14' }))).toBe(DAY_NOT_YET_TEXT);
    expect(textOf(await call(table, { date: '2026-01-01' }))).toBe(DAY_TOO_OLD_TEXT);
    expect(textOf(await call(table, { date: 'yesterday' }))).toBe(DAY_NOT_A_DATE_TEXT);
  });
});

describe('resolveDay — the day somebody means, worked out here and never by a model', () => {
  // NOW is Tuesday 13 October 2026.
  const day = (input: { date?: string; day?: string }) => resolveDay(input, NOW);

  it('is today when nothing is said', () => {
    expect(day({})).toEqual({ start: Date.UTC(2026, 9, 13), date: '2026-10-13', inWords: 'Tuesday 13 October 2026' });
  });

  it('reads "yesterday", and a weekday as the most recent one — today included', () => {
    expect(day({ day: 'yesterday' })).toMatchObject({ date: '2026-10-12', inWords: 'Monday 12 October 2026' });
    expect(day({ day: 'Friday' })).toMatchObject({ date: '2026-10-09' });
    expect(day({ day: 'tuesday' })).toMatchObject({ date: '2026-10-13' });
    expect(day({ day: 'wednesday' })).toMatchObject({ date: '2026-10-07' });
  });

  it('takes an exact date over a day name, and refuses what is neither', () => {
    expect(day({ date: '2026-10-06', day: 'friday' })).toMatchObject({ date: '2026-10-06', inWords: 'Tuesday 6 October 2026' });
    expect(day({ day: 'someday' })).toBeUndefined();
    expect(day({ date: 'last week' })).toBeUndefined();
  });
});

describe("resolveDay — a day is the house's own", () => {
  // 03:00 UTC on Wednesday 14 October is still Tuesday evening in Los Angeles.
  const lateTuesdayInLosAngeles = new Date(Date.UTC(2026, 9, 14, 3));

  it('is today where the house is, from its own midnight', () => {
    expect(resolveDay({}, lateTuesdayInLosAngeles, 'America/Los_Angeles')).toEqual({
      start: Date.UTC(2026, 9, 13, 7),
      date: '2026-10-13',
      inWords: 'Tuesday 13 October 2026',
    });
    expect(resolveDay({}, lateTuesdayInLosAngeles, 'UTC')).toMatchObject({ date: '2026-10-14' });
  });

  it('counts yesterday and the weekdays back from that day', () => {
    expect(resolveDay({ day: 'yesterday' }, lateTuesdayInLosAngeles, 'America/Los_Angeles')).toMatchObject({ date: '2026-10-12', start: Date.UTC(2026, 9, 12, 7) });
    expect(resolveDay({ day: 'friday' }, lateTuesdayInLosAngeles, 'America/Los_Angeles')).toMatchObject({ date: '2026-10-09' });
  });
});

describe('the day tools answer for the day where the house is', () => {
  const LA = 'America/Los_Angeles';
  // 02:00 UTC on Wednesday 14 October: seven in the evening on Tuesday in Los Angeles.
  const EVENING_IN_LA = new Date(Date.UTC(2026, 9, 14, 2));

  it('get_today, asked on a Los Angeles evening, is that Tuesday there: its morning in, the next UTC day out', async () => {
    const table = createMemoryTable();
    // 09:00 on Tuesday there (16:00 UTC), and 18:30 there (01:30 UTC on Wednesday).
    table.put({ pk: { S: `HH#${HH}` }, sk: { S: `EVT#${padTimestamp(Date.UTC(2026, 9, 13, 16))}#a` }, type: { S: 'door' } });
    table.put({ pk: { S: `HH#${HH}` }, sk: { S: `EVT#${padTimestamp(Date.UTC(2026, 9, 14, 1, 30))}#b` }, type: { S: 'door' } });
    // 23:30 on Monday there (06:30 UTC on Tuesday): the day before.
    table.put({ pk: { S: `HH#${HH}` }, sk: { S: `EVT#${padTimestamp(Date.UTC(2026, 9, 13, 6, 30))}#c` }, type: { S: 'door' } });
    const client = await connect(table, (s) => registerGetToday(s, table.ddb, allowedContext(HH, { timeZone: LA }), () => EVENING_IN_LA));

    const result = await client.callTool({ name: 'get_today', arguments: {} });

    expect(result.structuredContent).toMatchObject({
      date: '2026-10-13',
      dayInWords: 'Tuesday 13 October 2026',
      events: [{ at: Date.UTC(2026, 9, 13, 16) }, { at: Date.UTC(2026, 9, 14, 1, 30) }],
    });
  });

  it("did_visitor_come reads her usual days where the house is: a Friday-morning visit in Los Angeles is Friday's", async () => {
    const table = createMemoryTable();
    person(table, 'PER#maria', MARIA);
    // 09:05 on Friday 9 October in Los Angeles is 16:05 UTC.
    visit(table, Date.UTC(2026, 9, 9, 16, 5), MARIA);
    const client = await connect(table, (s) => registerDidVisitorCome(s, table.ddb, allowedContext(HH, { timeZone: LA }), () => EVENING_IN_LA));

    const friday = await client.callTool({ name: 'did_visitor_come', arguments: { personId: 'maria', day: 'friday' } });

    expect(friday.structuredContent).toMatchObject({ visited: true, at: Date.UTC(2026, 9, 9, 16, 5), expectedToday: true, date: '2026-10-09' });
  });
});

describe('the day tools take a day by name', () => {
  it('get_today answers for "yesterday" and says in words which day that was', async () => {
    const table = createMemoryTable();
    table.put({ pk: { S: `HH#${HH}` }, sk: { S: `EVT#${padTimestamp(Date.UTC(2026, 9, 12, 10))}#d` }, type: { S: 'door' } });
    const client = await connect(table, (s) => registerGetToday(s, table.ddb, allowedContext(HH), () => NOW));

    const result = await client.callTool({ name: 'get_today', arguments: { day: 'yesterday' } });

    expect(result.structuredContent).toMatchObject({ date: '2026-10-12', dayInWords: 'Monday 12 October 2026', events: [{ at: Date.UTC(2026, 9, 12, 10) }] });
  });

  it('did_visitor_come answers for a named day: "did Maria come on Friday?"', async () => {
    const table = createMemoryTable();
    person(table, 'PER#maria', MARIA);
    visit(table, Date.UTC(2026, 9, 9, 9, 5), MARIA);
    const client = await connect(table, (s) => registerDidVisitorCome(s, table.ddb, allowedContext(HH), () => NOW));

    const friday = await client.callTool({ name: 'did_visitor_come', arguments: { personId: 'maria', day: 'friday' } });
    const monday = await client.callTool({ name: 'did_visitor_come', arguments: { personId: 'maria', date: '2026-10-12' } });

    expect(friday.structuredContent).toMatchObject({ visited: true, at: Date.UTC(2026, 9, 9, 9, 5), name: 'Maria', expectedToday: true, date: '2026-10-09', dayInWords: 'Friday 9 October 2026' });
    expect(monday.structuredContent).toMatchObject({ visited: false, expectedToday: false, dayInWords: 'Monday 12 October 2026' });
  });

  it('did_visitor_come keeps to the same six weeks as get_today, and to days that have come', async () => {
    const table = createMemoryTable();
    person(table, 'PER#maria', MARIA);
    const client = await connect(table, (s) => registerDidVisitorCome(s, table.ddb, allowedContext(HH), () => NOW));
    const ask = async (date: string) => textOf(await client.callTool({ name: 'did_visitor_come', arguments: { personId: 'maria', date } }));

    expect(await ask('2026-10-14')).toBe(DAY_NOT_YET_TEXT);
    expect(await ask('2020-01-01')).toBe(DAY_TOO_OLD_TEXT);
    expect(await ask('whenever')).toBe(DAY_NOT_A_DATE_TEXT);
  });

  it('did_visitor_come still answers for today when no day is named', async () => {
    const table = createMemoryTable();
    person(table, 'PER#maria', MARIA);
    visit(table, Date.UTC(2026, 9, 13, 8, 55), MARIA);
    const client = await connect(table, (s) => registerDidVisitorCome(s, table.ddb, allowedContext(HH), () => NOW));

    expect((await client.callTool({ name: 'did_visitor_come', arguments: { personId: 'maria' } })).structuredContent).toMatchObject({ visited: true, date: '2026-10-13' });
  });
});

describe('get_resident_shared_view — in words, so nobody has to guess what a class means', () => {
  it('says what each shared and private kind of thing is', async () => {
    const table = createMemoryTable();
    table.put({ pk: { S: `HH#${HH}` }, sk: { S: 'META' }, residentExclusions: { SS: ['PRESENCE'] } });
    const client = await connect(table, (s) => registerGetResidentSharedView(s, table.ddb, allowedContext(HH)));

    const view = (await client.callTool({ name: 'get_resident_shared_view', arguments: {} })).structuredContent as Record<string, string[]>;

    expect(view.keptPrivateInWords).toEqual(['Who visits, by name']);
    expect(view.sharedInWords).toContain('When someone comes to the door');
    expect(view.sharedInWords).toContain('The shape of the week');
    expect(view.sharedInWords).toHaveLength(view.sharedWithFamily!.length);
  });
});
