/**
 * A household whose people are written in other scripts: the resident in
 * Cyrillic, her daughter in Greek, her carer in Chinese.
 *
 * Until the Guardian could tell a name from a sentence (policy foreign.ts),
 * every answer that named one of them held a letter it could not read and
 * was withheld whole: the family was told "Something went wrong" to every
 * question. These go through the real tool server, the family television's
 * routes and the assistant's reply check, with the household's own people
 * read from the table and the circle — and with the protected-fact checks
 * still on.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { currentIsoWeek, personIdFor, type FamilyTvHome, type WeekNarrative } from '@wick/contracts';
import { createMcpServer } from '../server.js';
import type { ToolContext } from '../tools/context.js';
import { VISITOR_NAME_NOT_SHARED_TEXT } from '../tools/add_regular_visitor.js';
import { householdPeople } from '../people.js';
import { createMemoryTable } from './memoryTable.js';
import { createMemoryStore } from '../accounts/__tests__/memoryStore.js';
import { checkReply } from '../assistant/brain.js';
import { NOW, bearer, world } from '../accounts/__tests__/familyTvWorld.js';
import { SOMETHING_WENT_WRONG_TEXT } from '../tools/errors.js';

const RESIDENT = 'Маргарита';
const DAUGHTER = 'Ελένη';
const CARER = '玛丽亚';
const nowhere = async (): Promise<void> => {};

beforeAll(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterAll(() => void vi.restoreAllMocks());

async function connect(server: McpServer): Promise<Client> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.1.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

/** The household's tool context, with its people given (people.ts) or not. */
function context(people?: () => Promise<readonly string[]>): ToolContext {
  return {
    householdId: 'hh-1',
    userId: 'u_daughter',
    access: async () => ({
      ok: true,
      membership: { householdId: 'hh-1', userId: 'u_daughter', name: DAUGHTER, role: 'organiser', status: 'allowed', requestedAt: 0 },
      household: { householdId: 'hh-1', name: 'Дом мамы', residentName: RESIDENT, createdBy: 'u_daughter', createdAt: 0 },
    }),
    ...(people ? { people } : {}),
  };
}

const row = (sk: string, data: unknown): Record<string, AttributeValue> => ({ pk: { S: 'HH#hh-1' }, sk: { S: sk }, data: { S: JSON.stringify(data) } });
const textOf = (result: unknown): string => (((result as { content?: { text?: string }[] }).content) ?? []).map((c) => c.text ?? '').join('\n');

describe('a household written in Cyrillic, Greek and Chinese, through the tool server', () => {
  it('tells the week with the names in it, and does not rewrite it from the counts', async () => {
    const table = createMemoryTable();
    const at = Date.now();
    const isoWeek = currentIsoWeek(new Date(at));
    const carerId = personIdFor(CARER);
    const narrative: WeekNarrative = {
      householdId: 'hh-1', isoWeek, textSource: 'agents',
      text: `${CARER} visited once, which is about usual. ${RESIDENT} watched a film.`,
      deltas: [{ metric: `visit:${carerId}`, label: CARER, thisWeek: 1, baseline: 1, zScore: 0, baselineWeeks: 4, verdict: 'usual' }],
      timeline: [{ at, kind: 'presence', summary: `Someone came to the door when ${CARER} was expected.`, personId: carerId, name: CARER }, { at, kind: 'door', summary: 'Someone was at the front door.' }],
      generatedAt: at, residentSeenAt: at,
    };
    table.put(row(`NARR#${isoWeek}`, narrative));
    const client = await connect(createMcpServer(table.ddb, context(async () => [RESIDENT, DAUGHTER, CARER, 'Дом мамы']), nowhere, nowhere, nowhere));

    const result = await client.callTool({ name: 'get_week_narrative', arguments: {} });

    expect(result.isError).toBeFalsy();
    const week = result.structuredContent as { text: string; textSource?: string; timeline: { summary: string }[] };
    expect(week.text).toBe(narrative.text);
    expect(week.textSource).toBe('agents');
    expect(week.timeline.map((e) => e.summary)).toEqual([`Someone came to the door when ${CARER} was expected.`, 'Someone was at the front door.']);
  });

  it('still withholds the week, and says nothing was held back, when the household’s people are not known', async () => {
    const table = createMemoryTable();
    const at = Date.now();
    const isoWeek = currentIsoWeek(new Date(at));
    table.put(row(`NARR#${isoWeek}`, { householdId: 'hh-1', isoWeek, text: `${CARER} visited once.`, textSource: 'agents', timeline: [], generatedAt: at, residentSeenAt: at }));
    const client = await connect(createMcpServer(table.ddb, context(), nowhere, nowhere, nowhere));

    const week = (await client.callTool({ name: 'get_week_narrative', arguments: {} })).structuredContent as { text: string; textSource?: string };

    // The control: the paragraph with a name nobody vouched for is not shown, as it was not before.
    expect(week.text).not.toContain(CARER);
    expect(week.textSource).toBe('facts');
  });

  it('answers an ordinary tool whose answer names the resident, instead of "Something went wrong"', async () => {
    const table = createMemoryTable();
    const known = await connect(createMcpServer(table.ddb, context(async () => [RESIDENT, DAUGHTER]), nowhere, nowhere, nowhere));
    const unknown = await connect(createMcpServer(table.ddb, context(), nowhere, nowhere, nowhere));

    const withPeople = await known.callTool({ name: 'get_light', arguments: {} });
    const without = await unknown.callTool({ name: 'get_light', arguments: {} });

    expect(withPeople.isError).toBeFalsy();
    expect(textOf(withPeople)).toContain(RESIDENT);
    // The control, so this test would have failed before: with nobody vouching for the name, it is withheld.
    expect(textOf(without)).toBe(SOMETHING_WENT_WRONG_TEXT);
  });

  it('keeps the protected-fact checks on: a sentence with the resident’s name and a doctor is still withheld', async () => {
    const table = createMemoryTable();
    const at = Date.now();
    const isoWeek = currentIsoWeek(new Date(at));
    table.put(row(`NARR#${isoWeek}`, { householdId: 'hh-1', isoWeek, text: `${RESIDENT} saw the doctor this week.`, textSource: 'agents', timeline: [], generatedAt: at, residentSeenAt: at }));
    const client = await connect(createMcpServer(table.ddb, context(async () => [RESIDENT, DAUGHTER]), nowhere, nowhere, nowhere));

    const week = (await client.callTool({ name: 'get_week_narrative', arguments: {} })).structuredContent as { text: string };

    expect(week.text).not.toContain('doctor');
    expect(week.text).not.toContain(RESIDENT + ' saw');
  });

  it('adds a regular visitor written in Chinese — her id is not empty — and lists her', async () => {
    const table = createMemoryTable();
    table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'POLICY' }, policy: { S: '{}' } });
    const ctx = context(async () => [RESIDENT, DAUGHTER, CARER]);
    const client = await connect(createMcpServer(table.ddb, ctx, nowhere, nowhere, nowhere));

    const added = await client.callTool({ name: 'add_regular_visitor', arguments: { name: CARER, days: ['tuesday'], time: '09:00' } });
    expect(textOf(added)).not.toContain('I need the name they go by');
    expect(textOf(added)).toContain(CARER);

    // The in-memory table takes no transactions: her row is put as the write would have made it.
    table.put({ pk: { S: 'HH#hh-1' }, sk: { S: `PER#${personIdFor(CARER)}` }, data: { S: JSON.stringify({ personId: personIdFor(CARER), name: CARER, expectedPattern: 'TUE 09:00±30m' }) } });
    const listed = await client.callTool({ name: 'list_regular_visitors', arguments: {} });
    expect(listed.isError).toBeFalsy();
    expect(textOf(listed)).toContain(CARER);
  });

  it('refuses a visitor whose name in another script says doctor', async () => {
    const table = createMemoryTable();
    const client = await connect(createMcpServer(table.ddb, context(async () => [RESIDENT]), nowhere, nowhere, nowhere));

    for (const name of ['医生', 'Доктор', 'γιατρός']) {
      const added = await client.callTool({ name: 'add_regular_visitor', arguments: { name, days: ['tuesday'], time: '09:00' } });
      expect(textOf(added), name).toBe(VISITOR_NAME_NOT_SHARED_TEXT);
    }
  });
});

describe('householdPeople', () => {
  it('is the resident, the home’s label, the roster and the circle', async () => {
    const table = createMemoryTable();
    const store = createMemoryStore();
    await store.createHousehold({ householdId: 'hh-1', name: 'Дом мамы', residentName: RESIDENT, createdBy: 'u_daughter', createdAt: 1 });
    await store.putMembership({ householdId: 'hh-1', userId: 'u_daughter', name: DAUGHTER, role: 'organiser', status: 'allowed', requestedAt: 0 });
    table.put({ pk: { S: 'HH#hh-1' }, sk: { S: `PER#${personIdFor(CARER)}` }, data: { S: JSON.stringify({ personId: personIdFor(CARER), name: CARER, expectedPattern: 'TUE 09:00±30m' }) } });

    const people = await householdPeople(table.ddb, store, 'hh-1');

    expect(new Set(people)).toEqual(new Set([RESIDENT, 'Дом мамы', DAUGHTER, CARER]));
  });

  it('is nobody for a household that is not there', async () => {
    expect(await householdPeople(createMemoryTable().ddb, createMemoryStore(), 'hh-missing')).toEqual([]);
  });
});

describe('a Cyrillic resident, on her daughter’s own television', () => {
  it('is shown the home, with her name in it', async () => {
    const w = await world({ resident: RESIDENT, sarah: { name: DAUGHTER } });
    const reply = await w.tv.home(bearer());
    expect(reply.status).toBe(200);
    expect((reply.body as FamilyTvHome).residentName).toBe(RESIDENT);
  });

  it('is still refused a card with a doctor in it', async () => {
    const w = await world({ resident: RESIDENT, sarah: { name: DAUGHTER } });
    w.table.put({
      pk: { S: 'HH#hh-1' }, sk: { S: 'CARD#door-abc' },
      data: { S: JSON.stringify({ id: 'door-abc', queuedAt: NOW - 10_000, card: { type: 'DOOR', description: 'A doctor at the door.' } }) },
    });
    // Whatever the television would say of a door, the doctor is not in it.
    const reply = await w.tv.home(bearer()).catch(() => ({ status: 500, body: null }));
    expect(JSON.stringify(reply.body ?? '')).not.toContain('doctor');
  });
});

describe('the assistant’s reply about a Cyrillic household', () => {
  const turns = [{ role: 'user' as const, text: 'How is she?' }];
  const now = new Date(NOW);

  it('is said when it names the people the household has', () => {
    const reply = `${RESIDENT} is well. ${CARER} came by.`;
    expect(checkReply(reply, turns, now, 'Europe/London', [RESIDENT, CARER])).toEqual({ ok: true });
  });

  it('is refused as protected when it names no one the household has', () => {
    expect(checkReply(`${RESIDENT} is well.`, turns, now, 'Europe/London')).toEqual({ ok: false, detail: 'protected' });
  });

  it('is refused when it says a protected thing about her', () => {
    expect(checkReply(`${RESIDENT} is at the hospital.`, turns, now, 'Europe/London', [RESIDENT])).toEqual({ ok: false, detail: 'protected' });
  });
});
