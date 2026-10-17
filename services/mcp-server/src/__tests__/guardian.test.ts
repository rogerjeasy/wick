/**
 * The family read boundary (guardian.ts): that it is where every tool and
 * every family-television route answers from, and what withholding looks
 * like to the family when it happens.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { currentIsoWeek, type FamilyTvHome, type WeekNarrative } from '@wick/contracts';
import { fallbackNarrative, isoWeekRange, summariseWeek } from '@wick/agent';
import { createMcpServer } from '../server.js';
import { firstUncleared, guardToolAnswer, guardTools, theirOwnWords, toolsBehindTheGate } from '../guardian.js';
import { SOMETHING_WENT_WRONG_TEXT } from '../tools/errors.js';
import { data, say } from '../tools/result.js';
import { allowedContext } from '../tools/__tests__/toolContext.js';
import { createMemoryTable, type MemoryTable } from './memoryTable.js';
import { NOW, bearer, putDoorCard, putLook, world } from '../accounts/__tests__/familyTvWorld.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const NURSE = 'A woman in a nurse’s uniform holding a medication box.';
const nowhere = async (): Promise<void> => {};

/** Every source file of the server, tests left out. */
function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

async function connect(server: McpServer): Promise<Client> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.1.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe('every family-bound answer passes the gate', () => {
  it('every tool the family is offered is registered behind it', async () => {
    const server = createMcpServer({ send: async () => ({}) } as unknown as DynamoDBClient, allowedContext('hh-1'), nowhere, nowhere, nowhere);
    const { tools } = await (await connect(server)).listTools();

    expect(tools.length).toBeGreaterThan(20);
    expect([...toolsBehindTheGate(server)].sort()).toEqual(tools.map((t) => t.name).sort());
  });

  it('has one MCP server in the source, and it is made behind the gate', () => {
    const made = sourceFiles().flatMap((path) => {
      const text = readFileSync(path, 'utf8');
      return [...text.matchAll(/(\w+\()?new McpServer\(/g)].map((m) => ({ file: relative(SRC, path), wrappedIn: m[1] }));
    });

    expect(made).toEqual([{ file: 'server.ts', wrappedIn: 'guardTools(' }]);
  });

  it('answers a family television only through the guarded endpoints', () => {
    // A route is served where a router or the app is told the path: `.get('/tv/…'`, `.post('/tv/…'`.
    const routes = sourceFiles().filter((path) => /\.(get|post|put|patch|delete|all|use)\(\s*['"`]\/tv\//.test(readFileSync(path, 'utf8')));
    const television = readFileSync(join(SRC, 'accounts/familyTelevision.ts'), 'utf8');

    // And /tv/stop, which answers the resident's own television, never a family member's, with nothing of hers:
    // `{ stopped: true }` or an error code (accounts/residentTelevision.ts). It reads no household's facts.
    expect(routes.map((path) => relative(SRC, path)).sort()).toEqual(['accounts/familyTelevisionRouter.ts', 'accounts/residentTelevisionRouter.ts']);
    expect(readFileSync(join(SRC, 'accounts/familyTelevisionRouter.ts'), 'utf8')).toMatch(/const television = createFamilyTelevision\(deps\)/);
    const stop = readFileSync(join(SRC, 'accounts/residentTelevision.ts'), 'utf8');
    expect(stop).not.toMatch(/from '\.\.\/tools\/|loadHouseholdPolicy|get_week_narrative/);
    expect(television).toMatch(/return guardTelevision<FamilyTelevisionEndpoints>\(\{/);
  });

  it('refuses the SDK’s older way of adding a tool, so it is not a way round', () => {
    const server = guardTools(new McpServer({ name: 'test', version: '0.1.0' }));
    expect(() => (server as unknown as { tool: (...args: unknown[]) => unknown }).tool('x', async () => say('hello'))).toThrow(/behind the Guardian/);
  });
});

describe('a tool answer the gate cannot clear', () => {
  it('is never sent: the family is told what any failed answer tells them, and the log has the place, never the words', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const answer = guardToolAnswer('get_anything', data({ visitors: [{ name: 'Maria' }, { name: 'Dr Patel' }] }));

    expect(answer).toEqual({ content: [{ type: 'text', text: SOMETHING_WENT_WRONG_TEXT }], isError: true });
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(JSON.parse(logged)).toEqual({ level: 'warn', msg: 'guardian_withheld', where: 'get_anything', at: '$.structuredContent.visitors[1].name', classes: ['HEALTH'] });
    expect(logged).not.toMatch(/patel/i);
    warn.mockRestore();
  });

  it('reads a sentence said as it stands, and a picture or file it cannot read is not sent at all', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(guardToolAnswer('t', say('Her pension came.'))).toMatchObject({ isError: true });
    expect(guardToolAnswer('t', { content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] })).toMatchObject({ isError: true });
    expect(guardToolAnswer('t', say('Maria came on Tuesday.'))).toEqual(say('Maria came on Tuesday.'));
    vi.restoreAllMocks();
  });

  it('does not read ids and addresses as words, but does read an id made from a name', () => {
    expect(firstUncleared({ requestId: 'door-gp-pin', pictureUrl: 'https://x.example/a.jpg?gp=1', isoWeek: '2026-W42' })).toBeUndefined();
    expect(firstUncleared({ personId: 'dr-patel-gp' })).toEqual({ at: '$.personId', classes: ['HEALTH'] });
  });

  it('passes the words Wick uses to name the classes, when it tells someone what the resident shares', () => {
    expect(firstUncleared({ residentExclusions: ['HEALTH'], keptPrivateInWords: ['Health', 'Money'] })).toBeUndefined();
    expect(firstUncleared({ note: 'Health' })).toBeUndefined();
    expect(firstUncleared({ note: 'Her health' })).toEqual({ at: '$.note', classes: ['HEALTH'] });
  });

  it('hands the reader’s own words back to them exactly, and nothing else', () => {
    const answer = theirOwnWords(data({ message: 'Is your hip still bad?', also: 'Is your knee bad?' }), ['Is your hip still bad?']);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(guardToolAnswer('t', answer)).toMatchObject({ isError: true });
    expect(guardToolAnswer('t', theirOwnWords(data({ message: 'Is your hip still bad?' }), ['Is your hip still bad?']))).toMatchObject({ structuredContent: { message: 'Is your hip still bad?' } });
    vi.restoreAllMocks();
  });
});

describe("the household's own people, whose names are also words (Anna Cash, Mrs Banks)", () => {
  const visitor = data({ visitors: [{ personId: 'anna-cash', name: 'Anna Cash' }] });

  it('passes a person the household holds by name, and her id, but nothing else said around her', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(guardToolAnswer('t', visitor)).toMatchObject({ isError: true });
    expect(guardToolAnswer('t', visitor, ['Anna Cash'])).toEqual(visitor);
    expect(guardToolAnswer('t', say('Anna Cash brought the pension.'), ['Anna Cash'])).toMatchObject({ isError: true });
    vi.restoreAllMocks();
  });

  it('asks who the household is only when an answer would otherwise be withheld', async () => {
    const people = vi.fn(async () => ['Anna Cash']);
    const server = guardTools(new McpServer({ name: 'test', version: '0.1.0' }), undefined, people);
    server.registerTool('visitors', { description: 'x' }, async () => visitor);
    server.registerTool('plain', { description: 'x' }, async () => say('Maria came on Tuesday.'));
    const client = await connect(server);

    expect((await client.callTool({ name: 'plain', arguments: {} })).content).toEqual(say('Maria came on Tuesday.').content);
    expect(people).not.toHaveBeenCalled();
    expect((await client.callTool({ name: 'visitors', arguments: {} })).structuredContent).toEqual(visitor.structuredContent);
    expect(people).toHaveBeenCalledTimes(1);
  });
});

/** The door card's question, as get_door_request answers it through the real server. */
async function doorRequest(table: MemoryTable): Promise<unknown> {
  const client = await connect(createMcpServer(table.ddb, allowedContext('hh-1'), nowhere, nowhere, nowhere));
  const result = await client.callTool({ name: 'get_door_request', arguments: {} });
  return result.structuredContent;
}

describe('withholding looks like something that already happens', () => {
  it('a door sentence the gate cannot clear is left out, exactly as when the model wrote none', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const asked = Date.now() - 30_000;
    const nurse = createMemoryTable();
    const unsure = createMemoryTable();
    for (const [table, over] of [[nurse, { description: NURSE }], [unsure, {}]] as const) {
      putDoorCard(table, 'door-abc', over, Date.now() + 240_000);
      putLook(table, 'door-abc', asked);
    }

    const withheld = await doorRequest(nurse);

    expect(withheld).toMatchObject({ state: 'waiting', line: "Someone's at the front door." });
    expect(withheld).not.toHaveProperty('description');
    expect(withheld).toEqual(await doorRequest(unsure));
    vi.restoreAllMocks();
  });

  it('on a family member’s own television, the door card says the line — as when there is no sentence', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nurse = await world();
    const unsure = await world();
    putDoorCard(nurse.table, 'door-abc', { description: NURSE });
    putDoorCard(unsure.table, 'door-abc');
    putLook(nurse.table, 'door-abc', NOW - 30_000);
    putLook(unsure.table, 'door-abc', NOW - 30_000);

    const card = async (w: typeof nurse) => ((await w.tv.home(bearer())).body as FamilyTvHome).cards[0];

    expect(await card(nurse)).toMatchObject({ kind: 'door_look', detail: "Someone's at the front door." });
    expect(await card(nurse)).toEqual(await card(unsure));
    vi.restoreAllMocks();
  });

  it('a week the gate cannot clear is told from its counts, as when the model failed — and never says something was kept', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const at = Date.now();
    const isoWeek = currentIsoWeek(new Date(at));
    const timeline = [
      { at, kind: 'visit' as const, summary: 'Maria visited.', personId: 'maria' },
      { at, kind: 'visit' as const, summary: 'Dr Patel visited.', personId: 'dr-patel' },
    ];
    const narrative: WeekNarrative = {
      householdId: 'hh-1', isoWeek, text: 'Maria came, and Dr Patel looked at her hip.', textSource: 'model',
      deltas: [], timeline, generatedAt: at, residentSeenAt: at,
    };
    const table = createMemoryTable();
    table.put({ pk: { S: 'HH#hh-1' }, sk: { S: `NARR#${isoWeek}` }, data: { S: JSON.stringify(narrative) } });

    const client = await connect(createMcpServer(table.ddb, allowedContext('hh-1'), nowhere, nowhere, nowhere));
    const week = (await client.callTool({ name: 'get_week_narrative', arguments: {} })).structuredContent as unknown as WeekNarrative;

    const kept = timeline.slice(0, 1);
    const facts = summariseWeek(kept, { timeZone: 'Europe/London', range: isoWeekRange(isoWeek), now: at });
    expect(week.text).toBe(fallbackNarrative(facts, []));
    expect(week.text).not.toMatch(/private|kept|withheld/i);
    expect(week.textSource).toBe('facts');
    expect(week.timeline).toEqual(kept);
    vi.restoreAllMocks();
  });
});
