import { describe, expect, it } from 'vitest';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMemoryTable } from '../../__tests__/memoryTable.js';
import type { ToolContext } from '../context.js';
import { registerGetPictures } from '../get_pictures.js';
import { allowedContext } from './toolContext.js';

// Monday 21 September 2026, 15:13 where the house is (Europe/London).
const NOW = 1_790_000_000_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

type Item = Record<string, AttributeValue>;

const picture = (photoId: string, sentBy: string, sentAt: number, seenAt?: number): Item => ({
  pk: { S: 'HH#hh-1' },
  sk: { S: `PHOTO#${photoId}` },
  photoId: { S: photoId },
  sentBy: { S: sentBy },
  sentByName: { S: sentBy === 'u_sarah' ? 'Sarah' : 'Tom' },
  sentAt: { N: String(sentAt) },
  ...(seenAt === undefined ? {} : { seenAt: { N: String(seenAt) } }),
});

async function tool(items: Item[], ctx: ToolContext = allowedContext('hh-1')) {
  const table = createMemoryTable();
  for (const item of items) table.put(item);
  const requests: { command: string; sk: string }[] = [];
  const ddb = {
    send: async (command: { constructor: { name: string }; input: { Key?: Item; ExpressionAttributeValues?: Item } }) => {
      requests.push({ command: command.constructor.name, sk: command.input.Key?.sk?.S ?? command.input.ExpressionAttributeValues?.[':prefix']?.S ?? '' });
      return (table.ddb as unknown as { send: (c: unknown) => Promise<unknown> }).send(command);
    },
  } as unknown as DynamoDBClient;
  const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
  registerGetPictures(mcpServer, ddb, ctx, () => NOW);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  const listed = (await client.listTools()).tools.find((t) => t.name === 'get_pictures')!;
  const result = await client.callTool({ name: 'get_pictures', arguments: {} });
  return { text: (result.content as { text: string }[])[0]!.text, result, listed, requests, table };
}

describe('get_pictures — "has Mum seen the picture I sent?"', () => {
  it('says one picture is waiting on her television until she has pressed a button on it', async () => {
    const { text } = await tool([picture('a', 'u_sarah', NOW - HOUR)]);

    expect(JSON.parse(text)).toEqual({
      summary: 'Your picture is waiting on Margaret’s television.',
      pictures: [{ sent: 'Monday 21 September at 2:13 pm', sentAt: NOW - HOUR, seen: false, say: 'It is waiting on Margaret’s television.' }],
    });
  });

  it('says she has seen it once she has — and that is all it says', async () => {
    const { text } = await tool([picture('a', 'u_sarah', NOW - HOUR, NOW - 60_000)]);

    expect(JSON.parse(text)).toEqual({
      summary: 'Margaret has seen your picture.',
      pictures: [{ sent: 'Monday 21 September at 2:13 pm', sentAt: NOW - HOUR, seen: true, say: 'Margaret has seen your picture.' }],
    });
    // Not when she saw it.
    expect(text).not.toContain(String(NOW - 60_000));
  });

  it.each([
    [3, 3, 'You have sent Margaret three pictures this week. Margaret has seen all of them.'],
    [3, 2, 'You have sent Margaret three pictures this week. Margaret has seen two of them.'],
    [3, 1, 'You have sent Margaret three pictures this week. Margaret has seen one of them.'],
    [2, 0, 'You have sent Margaret two pictures this week. They are waiting on Margaret’s television.'],
  ])('with several, says how many were sent and how many she has seen (%i sent, %i seen)', async (sent, seen, summary) => {
    const items = Array.from({ length: sent }, (_, i) => picture(`p${i}`, 'u_sarah', NOW - (i + 1) * HOUR, i < seen ? NOW - 1000 : undefined));

    expect((JSON.parse((await tool(items)).text) as { summary: string }).summary).toBe(summary);
  });

  it('lists the member’s own pictures of the last week, newest first, and nobody else’s', async () => {
    const { text } = await tool([
      picture('old', 'u_sarah', NOW - 8 * DAY),
      picture('mine-1', 'u_sarah', NOW - 2 * DAY),
      picture('toms', 'u_tom', NOW - HOUR),
      picture('mine-2', 'u_sarah', NOW - HOUR),
    ]);

    const { pictures } = JSON.parse(text) as { pictures: { sentAt: number }[] };
    expect(pictures.map((p) => p.sentAt)).toEqual([NOW - HOUR, NOW - 2 * DAY]);
    expect(text).not.toMatch(/toms|Tom/);
  });

  it('says so in a sentence when there is none', async () => {
    expect((await tool([picture('toms', 'u_tom', NOW - HOUR)])).text).toBe('You have not sent a picture to Margaret’s television this week.');
  });

  it('answers the same whether she kept it, only thanked them, or took it down afterwards', async () => {
    const seen = picture('a', 'u_sarah', NOW - HOUR, NOW - 60_000);
    const mantel: Item = { pk: { S: 'HH#hh-1' }, sk: { S: 'MANTEL#a' }, photoId: { S: 'a' }, keptAt: { N: String(NOW - 60_000) } };

    const kept = await tool([seen, mantel]);
    const thanked = await tool([seen]);

    expect(kept.text).toBe(thanked.text);
    // One read, of the pictures' own rows. Never her mantelpiece, and never the card.
    for (const { requests } of [kept, thanked]) expect(requests).toEqual([{ command: 'QueryCommand', sk: 'PHOTO#' }]);
  });

  it('gives no picture’s id and nothing that finds one: an assistant has no use for either', async () => {
    const { text } = await tool([picture('secret-id-123', 'u_sarah', NOW - HOUR)]);

    expect(text).not.toMatch(/secret-id-123|photoId|https?:|\.jpg/);
  });

  it('is a read, and says what it is for', async () => {
    const { listed } = await tool([]);

    expect(listed.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(listed.title).toBe('Pictures sent to the television');
    expect(listed.description).toContain('has seen');
    expect(listed.inputSchema.properties ?? {}).toEqual({});
  });

  it('is not for a neighbour, who sends nothing', async () => {
    const { text, requests } = await tool([picture('a', 'u_june', NOW - HOUR)], allowedContext('hh-1', { userId: 'u_june', name: 'June', role: 'neighbour' }));

    expect(text).toBe('Margaret has asked you to help in two ways: to look at who is at the door, and to ring when asked. Nothing else about the house is shared with a neighbour.');
    expect(requests).toEqual([]);
  });

  it('INV-9: is not answered for somebody she has not allowed', async () => {
    const waiting: ToolContext = { householdId: 'hh-1', userId: 'u_sarah', access: async () => ({ ok: false, reason: 'waiting', say: 'Margaret hasn’t allowed this yet.' }) };

    const { text, requests } = await tool([picture('a', 'u_sarah', NOW - HOUR)], waiting);

    expect(text).toBe('Margaret hasn’t allowed this yet.');
    expect(requests).toEqual([]);
  });
});
