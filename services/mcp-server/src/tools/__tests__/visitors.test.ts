import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { padTimestamp, type RosterEntry } from '@wick/contracts';
import { createMemoryTable, type MemoryTable } from '../../__tests__/memoryTable.js';
import { loadVisitors, registerListRegularVisitors } from '../list_regular_visitors.js';
import { EXPECT_VISIT_PAST_TEXT, EXPECT_VISIT_TOO_FAR_TEXT, registerExpectVisit } from '../expect_visit.js';
import { localToUtc } from '../when.js';
import { DAY_NOT_A_DATE_TEXT, DAY_NOT_YET_TEXT, DAY_TOO_OLD_TEXT, registerGetToday } from '../get_today.js';
import { FAMILY_REFUSAL_TEXT } from '../get_resident_shared_view.js';
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

    expect(await loadVisitors(table.ddb, HH, NOW)).toEqual({
      visitors: [{ personId: 'maria', name: 'Maria', usualDays: 'Tuesday and Friday mornings', expectedToday: true, lastVisitAt: Date.UTC(2026, 9, 13, 8, 55) }],
      expected: [],
    });
  });

  it('says nothing about a last visit it has no record of', async () => {
    const table = createMemoryTable();
    person(table, 'PER#maria', MARIA);

    const [maria] = (await loadVisitors(table.ddb, HH, new Date(Date.UTC(2026, 9, 14, 12)))).visitors;

    expect(maria).toEqual({ personId: 'maria', name: 'Maria', usualDays: 'Tuesday and Friday mornings', expectedToday: false });
  });

  it('lists a visit somebody has announced until it is over, and never after', async () => {
    const table = createMemoryTable();
    const at = Date.UTC(2026, 9, 17, 14);
    person(table, 'PER#member-u_sarah#2026-10-17', { personId: 'member-u_sarah', name: 'Sarah', expectedOnce: { at, windowMin: 60 } });
    person(table, 'PER#member-u_tom#2026-10-10', { personId: 'member-u_tom', name: 'Tom', expectedOnce: { at: Date.UTC(2026, 9, 10, 14), windowMin: 60 } });

    expect(await loadVisitors(table.ddb, HH, NOW)).toEqual({ visitors: [], expected: [{ name: 'Sarah', at }] });
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
    expect(result.structuredContent).toBeUndefined();
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
