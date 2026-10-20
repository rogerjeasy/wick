/**
 * "Doctor Rossi", arranged by Sarah, on a home David also belongs to.
 *
 * The errand's words are Sarah's own: read back whole to her by the errand
 * tools, and to nobody else. Every other tool that can name the roster or
 * the door's presence rows answers David without the title — never with it,
 * and never with "Something went wrong" because of it (errandNames.ts).
 * Through the real tool server, behind the real gate, with the household's
 * people read from the table and the circle as the deployed server reads
 * them (people.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { errandStore, type ErrandSend } from '@wick/agent';
import { DEFAULT_POLICY } from '@wick/policy';
import type { WeekNarrative } from '@wick/contracts';
import { createMcpServer } from '../../server.js';
import { householdPeople } from '../../people.js';
import { createMemoryTable, type MemoryTable } from '../../__tests__/memoryTable.js';
import { createMemoryStore } from '../../accounts/__tests__/memoryStore.js';
import { SOMETHING_WENT_WRONG_TEXT } from '../errors.js';
import { familyWeek } from '../get_week_narrative.js';
import type { ToolContext } from '../context.js';
import { allowedContext } from './toolContext.js';

const HH = 'hh-1';
const ERRAND = 'err_ROSSIROSSIROSSIROSS';
const nowhere = async (): Promise<void> => {};

beforeAll(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterAll(() => void vi.restoreAllMocks());

/** A home with Sarah's "Doctor Rossi" due in an hour, somebody at the door for them a minute ago, and Margaret asking David to look. */
async function home(): Promise<{ table: MemoryTable; people: () => Promise<readonly string[]> }> {
  const now = Date.now();
  const table = createMemoryTable();
  const store = createMemoryStore();
  await store.createHousehold({ householdId: HH, name: 'Margaret’s home', residentName: 'Margaret', createdBy: 'u_sarah', createdAt: 1 });
  await store.putMembership({ householdId: HH, userId: 'u_sarah', name: 'Sarah Hughes', role: 'organiser', status: 'allowed', requestedAt: 0 });
  await store.putMembership({ householdId: HH, userId: 'u_david', name: 'David', role: 'family', status: 'allowed', requestedAt: 0 });
  // The circle as the roster reads it (agent door/roster.ts stillWelcome): Sarah's visit stands on her word while she is allowed.
  for (const userId of ['u_sarah', 'u_david']) table.put({ pk: { S: `HH#${HH}` }, sk: { S: `MEM#${userId}` }, status: { S: 'allowed' } });
  const errands = errandStore((command) => table.ddb.send(command as never) as ReturnType<ErrandSend>, 'wick');
  await errands.create({
    errandId: ERRAND, householdId: HH, createdBy: 'u_sarah', createdByName: 'Sarah Hughes', who: 'Doctor Rossi',
    at: now + 3_600_000, windowMinutes: 60, tellMe: true, status: 'planned', createdAt: now - 86_400_000,
  });
  table.put({
    pk: { S: `HH#${HH}` }, sk: { S: `EVT#${String(now - 60_000).padStart(15, '0')}#p` },
    type: { S: 'presence' }, personId: { S: `errand:${ERRAND}` }, personName: { S: 'Doctor Rossi' },
  });
  table.put({
    pk: { S: `HH#${HH}` }, sk: { S: 'CARD#door-abc' },
    data: { S: JSON.stringify({ id: 'door-abc', urgency: 'DOOR', queuedAt: now - 60_000, expiresAt: now + 4 * 60_000, shownCount: 0,
      card: { type: 'DOOR', id: 'door-abc', householdId: HH, line: 'Doctor Rossi is at your door.', notice: 'They confirmed it on their phone just now. Sarah arranged this visit.', actions: [] } }) },
  });
  table.put({ pk: { S: `HH#${HH}` }, sk: { S: 'LOOK#door-abc' }, cardId: { S: 'door-abc' }, askedAt: { N: String(now - 30_000) }, expiresAt: { N: String(now + 4 * 60_000) } });
  return { table, people: () => householdPeople(table.ddb, store, HH) };
}

async function as(member: { userId: string; name: string }, world: Awaited<ReturnType<typeof home>>) {
  const ctx: ToolContext = { ...allowedContext(HH, { ...member, role: member.userId === 'u_sarah' ? 'organiser' : 'family' }), people: world.people };
  const errands = { start: async (name: string) => `arn:aws:states:eu-west-2:1:execution:wick-errand:${name}`, stop: async () => {} };
  const server = createMcpServer(world.table.ddb, ctx, nowhere, nowhere, nowhere, { errands });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.1.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const DAVID = { userId: 'u_david', name: 'David' };
const SARAH = { userId: 'u_sarah', name: 'Sarah Hughes' };

describe('an errand’s visitor, to a member who did not arrange it', () => {
  const CALLS: [string, Record<string, unknown>][] = [
    ['list_regular_visitors', {}],
    ['did_visitor_come', { personId: `errand:${ERRAND}` }],
    ['get_visits', {}],
    ['get_today', {}],
    ['get_door_request', {}],
    ['get_errands', {}],
    ['get_week_narrative', {}],
    ['get_whats_different', {}],
  ];

  for (const [name, args] of CALLS) {
    it(`${name} answers David, without the title`, async () => {
      const client = await as(DAVID, await home());

      const result = await client.callTool({ name, arguments: args });

      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      expect(JSON.stringify(result)).not.toContain(SOMETHING_WENT_WRONG_TEXT);
      expect(JSON.stringify(result)).not.toMatch(/doctor|rossi/i);
    });
  }

  it('is said as a visitor Sarah arranged, where the visitors expected are listed', async () => {
    const client = await as(DAVID, await home());

    const { expected } = (await client.callTool({ name: 'list_regular_visitors', arguments: {} })).structuredContent as { expected: { name: string }[] };

    expect(expected.map((e) => e.name)).toEqual(['a visitor Sarah arranged']);
  });

  it('is somebody at the door when a visitor was expected, in the day’s events', async () => {
    const client = await as(DAVID, await home());

    const { events } = (await client.callTool({ name: 'get_today', arguments: {} })).structuredContent as { events: { summary: string }[] };

    expect(events.map((e) => e.summary)).toContain('Someone came to the door when a visitor was expected.');
  });

  it('is the door’s standard line on Margaret’s question', async () => {
    const client = await as(DAVID, await home());

    expect((await client.callTool({ name: 'get_door_request', arguments: {} })).structuredContent).toMatchObject({ state: 'waiting', line: "Someone's at the front door." });
  });
});

describe('an errand’s visitor, to the member who arranged it', () => {
  it('is Sarah’s own words in the errand tools', async () => {
    const client = await as(SARAH, await home());

    const result = await client.callTool({ name: 'get_errands', arguments: {} });

    expect((result.structuredContent as { errands: { who: string }[] }).errands.map((e) => e.who)).toEqual(['Doctor Rossi']);
  });

  it('is not her words anywhere else, so the other tools answer her as they answer David', async () => {
    const client = await as(SARAH, await home());

    for (const name of ['list_regular_visitors', 'get_today', 'get_door_request']) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError, name).toBeFalsy();
      expect(JSON.stringify(result), name).not.toMatch(/doctor|rossi/i);
    }
  });
});

describe('the household’s people, which the gate may clear as names (people.ts)', () => {
  it('never holds an errand’s visitor', async () => {
    const { people } = await home();

    expect(await people()).not.toContain('Doctor Rossi');
    expect(new Set(await people())).toEqual(new Set(['Margaret', 'Margaret’s home', 'Sarah Hughes', 'David']));
  });
});

describe('a week with an errand’s visitor in it (get_week_narrative)', () => {
  it('is still read: the moment the gate cannot clear is left out, and the week told from what is left', () => {
    const week: WeekNarrative = {
      householdId: HH,
      isoWeek: '2026-W40',
      text: 'Someone came to the door when Doctor Rossi was expected.',
      textSource: 'model',
      deltas: [],
      timeline: [
        { at: Date.parse('2026-09-29T09:00:00Z'), kind: 'presence', summary: 'Someone came to the door when Doctor Rossi was expected.', personId: `errand:${ERRAND}`, name: 'Doctor Rossi' },
        { at: Date.parse('2026-09-30T18:10:00Z'), kind: 'door', summary: 'Someone was at the front door.' },
      ],
      generatedAt: Date.parse('2026-10-05T20:00:00Z'),
      residentSeenAt: Date.parse('2026-10-05T21:00:00Z'),
    };

    const result = familyWeek(week, DEFAULT_POLICY, 'Europe/London', ['Margaret', 'Doctor Rossi']);

    expect(result.status).toBe('available');
    expect(JSON.stringify(result)).not.toMatch(/doctor|rossi/i);
  });
});
