import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { WeekNarrative } from '@wick/contracts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadWeekNarrative, registerGetWeekNarrative } from '../get_week_narrative.js';

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
    expect(result).toEqual({ status: 'not_yet_available' });
  });

  it('reports not_yet_available when no narrative exists for the week', async () => {
    const ddb = { send: vi.fn().mockResolvedValue({ Item: undefined }) } as unknown as DynamoDBClient;
    const result = await loadWeekNarrative(ddb, 'hh-1', '2026-W38');
    expect(result).toEqual({ status: 'not_yet_available' });
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

    // Must read as "not ready" prose, never leak the narrative text or timeline.
    expect(content[0]!.text).not.toContain(unseen.text);
    expect(content[0]!.text).toMatch(/isn't ready/i);
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
