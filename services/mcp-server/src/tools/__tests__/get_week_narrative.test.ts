import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { FactClass, WeekNarrative } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  WEEK_AWAITING_RESIDENT_TEXT,
  WEEK_NOT_WRITTEN_TEXT,
  familyWeek,
  loadWeekNarrative,
  registerGetWeekNarrative,
} from '../get_week_narrative.js';

const NARRATIVE: WeekNarrative = {
  householdId: 'hh-1',
  isoWeek: '2026-W38',
  text: 'A quiet week. Margaret had her usual Tuesday visit from Maria.',
  deltas: [],
  timeline: [{ at: 1, kind: 'visit', summary: 'Maria visited, as usual.' }],
  generatedAt: 100,
  residentSeenAt: 200,
};

describe('loadWeekNarrative', () => {
  it('returns the narrative once the resident has seen it (INV-7)', async () => {
    const ddb = {
      send: vi.fn().mockResolvedValue({ Item: { data: { S: JSON.stringify(NARRATIVE) } } }),
    } as unknown as DynamoDBClient;
    const result = await loadWeekNarrative(ddb, 'hh-1', '2026-W38');
    expect(result).toEqual({ status: 'available', narrative: NARRATIVE });
  });

  it('withholds a narrative the resident has not yet seen (INV-7)', async () => {
    const unseen = { ...NARRATIVE, residentSeenAt: undefined };
    const ddb = {
      send: vi.fn().mockResolvedValue({ Item: { data: { S: JSON.stringify(unseen) } } }),
    } as unknown as DynamoDBClient;
    const result = await loadWeekNarrative(ddb, 'hh-1', '2026-W38');
    expect(result).toEqual({ status: 'awaiting_resident' });
  });

  it('reports not_written when no narrative exists for the week', async () => {
    const ddb = { send: vi.fn().mockResolvedValue({ Item: undefined }) } as unknown as DynamoDBClient;
    const result = await loadWeekNarrative(ddb, 'hh-1', '2026-W38');
    expect(result).toEqual({ status: 'not_written' });
  });
});

describe('get_week_narrative INV-7 guard (end-to-end through the registered tool)', () => {
  it('never returns narrative JSON when residentSeenAt is unset, even though the record exists', async () => {
    const unseen = { ...NARRATIVE, residentSeenAt: undefined };
    const ddb = {
      send: vi.fn().mockResolvedValue({ Item: { data: { S: JSON.stringify(unseen) } } }),
    } as unknown as DynamoDBClient;

    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerGetWeekNarrative(mcpServer, ddb);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'get_week_narrative', arguments: { isoWeek: '2026-W38' } });
    const content = result.content as { type: string; text: string }[];

    // Says why, in the product's own voice — and never leaks the text or timeline.
    expect(content[0]!.text).not.toContain(unseen.text);
    expect(content[0]!.text).toBe(WEEK_AWAITING_RESIDENT_TEXT);
  });

  it('says plainly when no week has been written yet', async () => {
    const ddb = { send: vi.fn().mockResolvedValue({ Item: undefined }) } as unknown as DynamoDBClient;
    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerGetWeekNarrative(mcpServer, ddb);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'get_week_narrative', arguments: { isoWeek: '2026-W38' } });
    expect((result.content as { type: string; text: string }[])[0]!.text).toBe(WEEK_NOT_WRITTEN_TEXT);
  });

  it('returns the narrative JSON once residentSeenAt is set', async () => {
    const ddb = {
      send: vi.fn().mockResolvedValue({ Item: { data: { S: JSON.stringify(NARRATIVE) } } }),
    } as unknown as DynamoDBClient;

    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerGetWeekNarrative(mcpServer, ddb);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'get_week_narrative', arguments: { isoWeek: '2026-W38' } });
    const content = result.content as { type: string; text: string }[];
    const parsed = JSON.parse(content[0]!.text) as WeekNarrative;

    expect(parsed).toEqual(NARRATIVE);
  });
});

describe('familyWeek — Sarah’s copy honours what Margaret keeps private ("What Sarah sees")', () => {
  // 2026-W40: two door visits on Wednesday evening (London), and Maria on Tuesday.
  const WEEK: WeekNarrative = {
    householdId: 'hh-1',
    isoWeek: '2026-W40',
    text: 'Someone came to the front door twice, and Maria visited once.',
    textSource: 'model',
    deltas: [],
    timeline: [
      { at: Date.parse('2026-09-29T09:00:00Z'), kind: 'visit', summary: 'Maria visited.', personId: 'maria' },
      { at: Date.parse('2026-09-30T18:10:00Z'), kind: 'door', summary: 'Someone was at the front door.' },
      { at: Date.parse('2026-09-30T18:40:00Z'), kind: 'door', summary: 'Someone was at the front door.' },
    ],
    generatedAt: Date.parse('2026-10-05T20:00:00Z'),
    residentSeenAt: Date.parse('2026-10-05T21:00:00Z'),
  };
  const policy = (residentExclusions: FactClass[]) => ({ ...DEFAULT_POLICY, residentExclusions });

  it('is the week as written when nothing is kept private', () => {
    expect(familyWeek(WEEK, policy([]), 'Europe/London')).toEqual({ status: 'available', narrative: WEEK });
  });

  it('drops who visited, and rewrites the prose from the facts that are still shared', () => {
    const result = familyWeek(WEEK, policy(['PRESENCE']), 'Europe/London');
    if (result.status !== 'available') throw new Error('expected available');
    expect(result.narrative.timeline.map((e) => e.kind)).toEqual(['door', 'door']);
    expect(result.narrative.text).toBe('Someone came to the front door twice this week, on Wednesday evening. Some of this week is kept private.');
    expect(result.narrative.text).not.toContain('Maria');
    expect(result.narrative.textSource).toBe('facts');
  });

  it('drops the door, without ever saying nobody came', () => {
    const result = familyWeek(WEEK, policy(['DOOR_EVENT']), 'Europe/London');
    if (result.status !== 'available') throw new Error('expected available');
    expect(result.narrative.timeline.map((e) => e.kind)).toEqual(['visit']);
    expect(result.narrative.text).toBe('Maria visited once. Some of this week is kept private.');
  });

  it('withholds the whole week when the resident keeps the summary of their week private', () => {
    expect(familyWeek(WEEK, policy(['RHYTHM']), 'Europe/London')).toEqual({ status: 'private' });
  });
});

describe('get_week_narrative honours "What Sarah sees" (end to end through the registered tool)', () => {
  const callWith = async (exclusions: string[]) => {
    const ddb = {
      send: vi.fn(async (cmd: { input: { Key: { sk: { S: string } } } }) =>
        cmd.input.Key.sk.S === 'META'
          ? { Item: exclusions.length ? { residentExclusions: { SS: exclusions } } : undefined }
          : { Item: { data: { S: JSON.stringify(NARRATIVE) } } },
      ),
    } as unknown as DynamoDBClient;
    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerGetWeekNarrative(mcpServer, ddb);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'get_week_narrative', arguments: { isoWeek: '2026-W38' } });
    return (result.content as { type: string; text: string }[])[0]!.text;
  };

  it('declines, warmly, when the resident keeps their week to themselves — and leaks nothing of it', async () => {
    const text = await callWith(['RHYTHM']);
    expect(text).toBe("That's something the resident is keeping to themselves. I'm not able to share it.");
    expect(text).not.toContain('Maria');
  });

  it('leaves out the visitors when the resident keeps them private', async () => {
    const week = JSON.parse(await callWith(['PRESENCE'])) as WeekNarrative;
    expect(week.timeline).toEqual([]);
    expect(week.text).not.toContain('Maria');
  });
});
