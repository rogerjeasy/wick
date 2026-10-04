import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadNoteReplies, registerGetReplies } from '../get_replies.js';
import { allowedContext } from './toolContext.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_790_900_000_000;

const note = (id: string, sentAt: number, reply?: { text: string; at: number }) => ({
  pk: { S: 'HH#hh-1' },
  sk: { S: `CARD#note-${id}` },
  data: {
    S: JSON.stringify({
      id: `note-${id}`,
      queuedAt: sentAt,
      card: { type: 'MESSAGE', fromName: 'Sarah', transcript: `Note ${id}`, suggestedReplies: ['Thanks', 'Call soon', 'Not now'] },
    }),
  },
  ...(reply ? { replyText: { S: reply.text }, repliedAt: { N: String(reply.at) } } : {}),
});

const ddbReturning = (items: unknown[]) => {
  const send = vi.fn().mockResolvedValue({ Items: items });
  return { ddb: { send } as unknown as DynamoDBClient, send };
};

describe('loadNoteReplies', () => {
  it('reads only this household’s notes, by their CARD#note- keys', async () => {
    const { ddb, send } = ddbReturning([]);
    await loadNoteReplies(ddb, 'hh-1', NOW);

    const input = (send.mock.calls[0]![0] as QueryCommand).input;
    expect(input.KeyConditionExpression).toBe('pk = :pk AND begins_with(sk, :prefix)');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': { S: 'HH#hh-1' }, ':prefix': { S: 'CARD#note-' } });
  });

  it('lists the last week’s notes, newest first, each with its reply or none yet', async () => {
    const { ddb } = ddbReturning([
      note('old', NOW - 9 * DAY, { text: 'Thanks', at: NOW - 8 * DAY }),
      note('a', NOW - 2 * DAY, { text: 'Call soon', at: NOW - DAY }),
      note('b', NOW - 3_600_000),
    ]);

    expect(await loadNoteReplies(ddb, 'hh-1', NOW)).toEqual([
      { from: 'Sarah', message: 'Note b', sentAt: NOW - 3_600_000, reply: null },
      { from: 'Sarah', message: 'Note a', sentAt: NOW - 2 * DAY, reply: { text: 'Call soon', at: NOW - DAY } },
    ]);
  });

  it('keeps the answer short: at most five notes', async () => {
    const { ddb } = ddbReturning(Array.from({ length: 8 }, (_, i) => note(String(i), NOW - i * 60_000)));
    expect(await loadNoteReplies(ddb, 'hh-1', NOW)).toHaveLength(5);
  });
});

describe('get_replies (end to end through the registered tool)', () => {
  it('answers with the replies as JSON, and says so plainly when no notes were sent', async () => {
    const connect = async (items: unknown[]) => {
      const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
      registerGetReplies(mcpServer, ddbReturning(items).ddb, allowedContext('hh-1'), () => NOW);
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '0.1.0' });
      await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: 'get_replies', arguments: {} });
      return (result.content as { type: string; text: string }[])[0]!.text;
    };

    expect(JSON.parse(await connect([note('a', NOW - DAY, { text: 'Thanks', at: NOW - 60_000 })]))).toEqual({
      notes: [{ from: 'Sarah', message: 'Note a', sentAt: NOW - DAY, reply: { text: 'Thanks', at: NOW - 60_000 } }],
    });
    expect(await connect([])).toBe('No notes have been sent to the television this week.');
  });
});
