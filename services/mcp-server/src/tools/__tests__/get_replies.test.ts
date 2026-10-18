import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadNoteReplies, registerGetReplies } from '../get_replies.js';
import { allowedContext } from './toolContext.js';
import { guardTools } from '../../guardian.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_790_900_000_000;

const note = (id: string, sentAt: number, reply?: { text: string; at: number }, sentBy: string | undefined = 'u_sarah', seenAt?: number) => ({
  pk: { S: 'HH#hh-1' },
  sk: { S: `CARD#note-${id}` },
  ...(sentBy ? { sentBy: { S: sentBy } } : {}),
  data: {
    S: JSON.stringify({
      id: `note-${id}`,
      queuedAt: sentAt,
      card: { type: 'MESSAGE', fromName: 'Sarah', transcript: `Note ${id}`, suggestedReplies: ['Thanks', 'Call soon', 'Not now'] },
    }),
  },
  ...(reply ? { replyText: { S: reply.text }, repliedAt: { N: String(reply.at) } } : {}),
  ...(seenAt !== undefined ? { seenAt: { N: String(seenAt) } } : {}),
});

const ddbReturning = (items: unknown[]) => {
  const send = vi.fn().mockResolvedValue({ Items: items });
  return { ddb: { send } as unknown as DynamoDBClient, send };
};

describe('loadNoteReplies', () => {
  it('reads only this household’s notes, by their CARD#note- keys', async () => {
    const { ddb, send } = ddbReturning([]);
    await loadNoteReplies(ddb, 'hh-1', 'u_sarah', NOW);

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

    expect(await loadNoteReplies(ddb, 'hh-1', 'u_sarah', NOW)).toEqual([
      { from: 'Sarah', message: 'Note b', sentAt: NOW - 3_600_000, reply: null, seen: false },
      { from: 'Sarah', message: 'Note a', sentAt: NOW - 2 * DAY, reply: { text: 'Call soon', at: NOW - DAY }, seen: true },
    ]);
  });

  it('leaves out a wave from a family member’s own television: it travels as a note, and is not one anybody wrote', async () => {
    const wave = (id: string, reply?: { text: string; at: number }) => ({
      pk: { S: 'HH#hh-1' },
      sk: { S: `CARD#note-wave-${id}` },
      data: { S: JSON.stringify({ id: `note-wave-${id}`, queuedAt: NOW - DAY, card: { type: 'MESSAGE', fromName: 'Sarah', transcript: 'Sarah is waving to you from their television.', suggestedReplies: ['Wave back', 'Not now'] } }) },
      ...(reply ? { replyText: { S: reply.text }, repliedAt: { N: String(reply.at) } } : {}),
    });
    const { ddb } = ddbReturning([wave('a'), wave('b', { text: 'Wave back', at: NOW - 1 }), wave('c', { text: 'Not now', at: NOW - 2 }), note('1', NOW - 2 * DAY)]);

    const notes = await loadNoteReplies(ddb, 'hh-1', 'u_sarah', NOW);

    expect(notes).toEqual([{ from: 'Sarah', message: 'Note 1', sentAt: NOW - 2 * DAY, reply: null, seen: false }]);
  });

  it('gives the words of a note only to the person who wrote it: everyone else sees who, when and her reply', async () => {
    const { ddb } = ddbReturning([
      note('mine', NOW - DAY, { text: "I'm fine, thank you.", at: NOW - 60_000 }),
      note('toms', NOW - 2 * DAY, { text: "I'm fine, thank you.", at: NOW - DAY }, 'u_tom'),
      // Written before the writer was kept on the row: nobody's to read back.
      note('old', NOW - 3 * DAY, undefined, undefined),
    ]);

    expect(await loadNoteReplies(ddb, 'hh-1', 'u_tom', NOW)).toEqual([
      { from: 'Sarah', message: null, sentAt: NOW - DAY, reply: { text: "I'm fine, thank you.", at: NOW - 60_000 }, seen: true },
      { from: 'Sarah', message: 'Note toms', sentAt: NOW - 2 * DAY, reply: { text: "I'm fine, thank you.", at: NOW - DAY }, seen: true },
      { from: 'Sarah', message: null, sentAt: NOW - 3 * DAY, reply: null, seen: false },
    ]);
  });

  it('says whether she has seen each note — once she has answered it, or put it away for later — and never when', async () => {
    const { ddb } = ddbReturning([
      note('later', NOW - DAY, undefined, 'u_sarah', NOW - 60_000),
      note('waiting', NOW - 2 * DAY),
    ]);

    const notes = await loadNoteReplies(ddb, 'hh-1', 'u_sarah', NOW);

    expect(notes.map((n) => [n.message, n.reply, n.seen])).toEqual([
      ['Note later', null, true],
      ['Note waiting', null, false],
    ]);
    expect(JSON.stringify(notes)).not.toContain(String(NOW - 60_000));
  });

  it('keeps the answer short: at most five notes', async () => {
    const { ddb } = ddbReturning(Array.from({ length: 8 }, (_, i) => note(String(i), NOW - i * 60_000)));
    expect(await loadNoteReplies(ddb, 'hh-1', 'u_sarah', NOW)).toHaveLength(5);
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
      notes: [{ from: 'Sarah', message: 'Note a', sentAt: NOW - DAY, reply: { text: 'Thanks', at: NOW - 60_000 }, seen: true }],
    });
    expect(await connect([])).toBe('No notes have been sent to the television this week.');
  });

  it('hands a note about her hip back to the person who wrote it, through the Guardian, and to nobody else', async () => {
    const asked = (by: string, reader: string) => ({
      ...note('hip', NOW - DAY, { text: "I'm fine, thank you.", at: NOW - 60_000 }, by),
      data: { S: JSON.stringify({ id: 'note-hip', queuedAt: NOW - DAY, card: { type: 'MESSAGE', fromName: 'Tom', transcript: 'Is your hip still bad? Did the pension come?', suggestedReplies: [] } }) },
      reader,
    });
    const read = async ({ reader, ...item }: ReturnType<typeof asked>) => {
      const mcpServer = guardTools(new McpServer({ name: 'test', version: '0.1.0' }));
      registerGetReplies(mcpServer, ddbReturning([item]).ddb, allowedContext('hh-1', { userId: reader }), () => NOW);
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '0.1.0' });
      await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: 'get_replies', arguments: {} });
      return JSON.parse((result.content as { type: string; text: string }[])[0]!.text) as { notes: { message: string | null }[] };
    };

    expect((await read(asked('u_tom', 'u_tom'))).notes[0]!.message).toBe('Is your hip still bad? Did the pension come?');
    expect((await read(asked('u_tom', 'u_sarah'))).notes[0]!.message).toBeNull();
  });
});
