import { describe, expect, it, vi } from 'vitest';
import { GetItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import type { HomeState } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMemoryTable, type MemoryTable } from '../../__tests__/memoryTable.js';
import { gated, type ToolContext } from '../context.js';
import { registerGetLight } from '../get_light.js';
import { LOOK_EVERY_MS, recordLook } from '../lookIn.js';
import { allowedContext } from './toolContext.js';

/** Monday 12 October 2026, 10:30 in London (BST). */
const NOW = Date.UTC(2026, 9, 12, 9, 30);
const HOUR = 3_600_000;

const television = (table: MemoryTable, id: string, activeSignalAt?: number): void =>
  table.put({ pk: { S: 'HH#hh-1' }, sk: { S: `DEV#${id}` }, ...(activeSignalAt === undefined ? {} : { activeSignalAt: { N: String(activeSignalAt) } }) });
const putOut = (table: MemoryTable, at: number): void => table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'LIGHT' }, outAt: { N: String(at) } });
const row = async (table: MemoryTable, sk: string): Promise<Record<string, AttributeValue> | undefined> =>
  (await table.ddb.send(new GetItemCommand({ TableName: 'wick', Key: { pk: { S: 'HH#hh-1' }, sk: { S: sk } } }))).Item;

async function ask(table: MemoryTable, ctx: ToolContext = allowedContext('hh-1'), now = NOW) {
  const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
  registerGetLight(mcpServer, table.ddb, ctx, () => now);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  const listed = (await client.listTools()).tools.find((t) => t.name === 'get_light');
  const result = await client.callTool({ name: 'get_light', arguments: {} });
  return { listed, text: (result.content as { text: string }[])[0]!.text, structured: result.structuredContent as Record<string, unknown> | undefined };
}

describe('get_light — the light in the window', () => {
  it('is lit once her television has been in use today, and says that and nothing more', async () => {
    const table = createMemoryTable();
    television(table, 'wick-tv', NOW - HOUR);

    const { listed, structured } = await ask(table);

    expect(listed?.annotations).toMatchObject({ readOnlyHint: true });
    expect(structured).toEqual({
      lit: true,
      summary: 'The light is on at Margaret’s: the day has begun there.',
      seen: 'Margaret can see that you looked in.',
    });
  });

  it('never says when, how often, or on which television', async () => {
    const table = createMemoryTable();
    television(table, 'living-room', NOW - HOUR);
    television(table, 'bedroom', NOW - 3 * HOUR);

    const { text } = await ask(table);

    expect(text).not.toMatch(/\d{2}:\d{2}|\d{10,}|living-room|bedroom|activeSignalAt|television/i);
  });

  it('is not lit before her day has begun, and says it could be either reason', async () => {
    const table = createMemoryTable();
    television(table, 'wick-tv', NOW - 14 * HOUR); // yesterday evening

    expect((await ask(table)).structured).toEqual({
      lit: false,
      summary: 'The light isn’t on at Margaret’s. It may not be lit yet today, or Margaret may have put it out.',
      seen: 'Margaret can see that you looked in.',
    });
  });

  it('looks exactly the same when she put it out as when it was never lit', async () => {
    const never = createMemoryTable();
    television(never, 'wick-tv');
    const out = createMemoryTable();
    television(out, 'wick-tv', NOW - HOUR);
    putOut(out, NOW - 30 * 60_000);

    expect((await ask(out)).structured).toEqual((await ask(never)).structured);
    expect((await ask(out)).text).toBe((await ask(never)).text);
  });

  it('is lit again the day after she put it out', async () => {
    const table = createMemoryTable();
    putOut(table, NOW - HOUR);
    television(table, 'wick-tv', NOW + 23 * HOUR);

    expect((await ask(table, allowedContext('hh-1'), NOW + 24 * HOUR)).structured).toMatchObject({ lit: true });
  });

  it('is refused, in the words every tool uses, when she keeps the shape of her week private', async () => {
    const table = createMemoryTable();
    table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'META' }, policy: { S: JSON.stringify({ ...DEFAULT_POLICY, residentExclusions: ['RHYTHM'] }) } });
    television(table, 'wick-tv', NOW - HOUR);

    const { text, structured } = await ask(table);

    expect(text).toBe("That's something the resident is keeping to themselves. I'm not able to share it.");
    expect(structured).toBeUndefined();
  });

  it('counts as looking in', async () => {
    const table = createMemoryTable();
    const lookedIn = vi.fn(async () => {});

    await ask(table, { ...allowedContext('hh-1'), lookedIn });

    expect(lookedIn).toHaveBeenCalledTimes(1);
  });
});

describe('recordLook — who looked in', () => {
  const who = { householdId: 'hh-1', userId: 'u_sarah', name: 'Sarah Hughes' };

  it('keeps who it was and when, and tells her television, by first name', async () => {
    const table = createMemoryTable();
    const told: [string, HomeState][] = [];

    await recordLook(table.ddb, who, NOW, async (householdId, home) => void told.push([householdId, home]));

    expect(await row(table, 'LOOKIN#u_sarah')).toMatchObject({ name: { S: 'Sarah' }, lookedAt: { N: String(NOW) } });
    // With the moment it stops being today's, where the house is: her television's own clock is not asked.
    expect(told).toEqual([['hh-1', { lookedIn: { name: 'Sarah', at: NOW, line: 'Sarah looked in this morning.', until: Date.UTC(2026, 9, 12, 23, 0) } }]]);
  });

  it('does not keep the row for ever', async () => {
    const table = createMemoryTable();

    await recordLook(table.ddb, who, NOW, async () => {});

    const ttl = Number((await row(table, 'LOOKIN#u_sarah'))!.ttl!.N);
    expect(ttl).toBeGreaterThan(NOW / 1000);
    expect(ttl).toBeLessThanOrEqual(NOW / 1000 + 3 * 86_400);
  });

  it('says so once for a run of questions, not once for each', async () => {
    const table = createMemoryTable();
    const tell = vi.fn(async () => {});

    await recordLook(table.ddb, who, NOW, tell);
    await recordLook(table.ddb, who, NOW + 60_000, tell);
    await recordLook(table.ddb, who, NOW + LOOK_EVERY_MS - 1, tell);

    expect(tell).toHaveBeenCalledTimes(1);
    expect(await row(table, 'LOOKIN#u_sarah')).toMatchObject({ lookedAt: { N: String(NOW) } });

    await recordLook(table.ddb, who, NOW + LOOK_EVERY_MS, tell);
    expect(tell).toHaveBeenCalledTimes(2);
  });

  it('is never the reason an answer fails: a television that cannot be reached is not an error', async () => {
    const table = createMemoryTable();

    await expect(recordLook(table.ddb, who, NOW, async () => { throw new Error('gone'); })).resolves.toBeUndefined();
    expect(await row(table, 'LOOKIN#u_sarah')).toBeDefined();
  });
});

describe('gated — which questions count as looking in', () => {
  it('notes the look for a question that asks after her, once she has allowed the person', async () => {
    const lookedIn = vi.fn(async () => {});
    const ctx = { ...allowedContext('hh-1'), lookedIn };

    expect(await gated(ctx, async () => 'answer', { looksIn: true })()).toBe('answer');
    expect(lookedIn).toHaveBeenCalledTimes(1);
  });

  it('notes nothing for any other tool, nor for somebody she has not allowed', async () => {
    const lookedIn = vi.fn(async () => {});
    const refused: ToolContext = { householdId: 'hh-1', userId: 'u_x', access: async () => ({ ok: false, say: 'Margaret hasn’t allowed this yet.' }) as never, lookedIn };

    await gated({ ...allowedContext('hh-1'), lookedIn }, async () => 'answer')();
    await gated(refused, async () => 'answer', { looksIn: true })();

    expect(lookedIn).not.toHaveBeenCalled();
  });

  it('answers all the same when the look cannot be noted', async () => {
    const ctx = { ...allowedContext('hh-1'), lookedIn: async () => { throw new Error('table down'); } };

    expect(await gated(ctx, async () => 'answer', { looksIn: true })()).toBe('answer');
  });
});
