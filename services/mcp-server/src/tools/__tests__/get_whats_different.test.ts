import { describe, expect, it, vi } from 'vitest';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { padTimestamp } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadWhatsDifferent, registerGetWhatsDifferent } from '../get_whats_different.js';
import { allowedContext } from './toolContext.js';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const HOUR = 3_600_000;
/** Friday 9 October 2026, two in the afternoon UTC. */
const FRIDAY = Date.UTC(2026, 9, 9);
const NOW = new Date(FRIDAY + 14 * HOUR);

type Item = Record<string, AttributeValue>;
const evt = (at: number, fields: Item): Item => ({ pk: { S: 'HH#hh-1' }, sk: { S: `EVT#${padTimestamp(at)}#x` }, ...fields });
const mariaVisit = (at: number): Item => evt(at, { type: { S: 'presence' }, personId: { S: 'maria' }, personName: { S: 'Maria' } });
const doorCall = (at: number): Item => evt(at, { type: { S: 'door' } });

/** Maria on every Tuesday and Friday for six weeks before this Friday, and this Tuesday — but not today. */
const sixWeeksOfMaria: Item[] = [
  ...[1, 2, 3, 4, 5, 6].flatMap((k) => [mariaVisit(FRIDAY - k * WEEK + 9 * HOUR), mariaVisit(FRIDAY - 3 * DAY - k * WEEK + 9 * HOUR)]),
  mariaVisit(FRIDAY - 3 * DAY + 9 * HOUR),
];
const maria: Item = { sk: { S: 'PER#maria' }, data: { S: JSON.stringify({ personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' }) } };

/** A table that answers the three reads the tool makes, and counts the ones about visitors. */
function table(events: Item[], { policy = DEFAULT_POLICY, firstAt = FRIDAY - 8 * WEEK }: { policy?: typeof DEFAULT_POLICY; firstAt?: number } = {}) {
  const rosterReads: string[] = [];
  const send = vi.fn().mockImplementation((cmd: { constructor: { name: string }; input: { ExpressionAttributeValues?: Record<string, AttributeValue>; Limit?: number } }) => {
    if (cmd.constructor.name === 'GetItemCommand') return Promise.resolve({ Item: { policy: { S: JSON.stringify(policy) } } });
    const prefix = cmd.input.ExpressionAttributeValues?.[':prefix']?.S;
    if (prefix === 'PER#' || prefix === 'MEM#') {
      rosterReads.push(prefix);
      return Promise.resolve({ Items: prefix === 'PER#' ? [maria] : [] });
    }
    if (prefix === 'EVT#') return Promise.resolve({ Items: [evt(firstAt, { type: { S: 'door' } })] });
    return Promise.resolve({ Items: events });
  });
  return { ddb: { send } as unknown as DynamoDBClient, rosterReads };
}

describe('loadWhatsDifferent', () => {
  it("says the visitor who did not come, in the Rhythm pillar's own words, and that nothing else is different", async () => {
    const { ddb } = table(sixWeeksOfMaria);

    const answer = await loadWhatsDifferent(ddb, 'hh-1', NOW, DEFAULT_POLICY);

    expect(answer).toEqual({
      weeksObserved: 6,
      enoughHistory: true,
      differences: [{ kind: 'missed_visit', sentence: 'Maria usually comes on Friday mornings. There has been no visit today.', at: FRIDAY + 9 * HOUR }],
      keptPrivate: [],
      summary: 'Maria usually comes on Friday mornings. There has been no visit today. Nothing else is different from the usual.',
    });
  });

  it('says that nothing is different on a usual day', async () => {
    const { ddb } = table([...sixWeeksOfMaria, mariaVisit(FRIDAY + 9 * HOUR)]);

    const answer = await loadWhatsDifferent(ddb, 'hh-1', NOW, DEFAULT_POLICY);

    expect(answer.differences).toEqual([]);
    expect(answer.summary).toBe('Nothing is different from the usual today.');
  });

  it('says it cannot tell yet, rather than "nothing", before three weeks', async () => {
    const { ddb } = table(sixWeeksOfMaria, { firstAt: FRIDAY - 10 * DAY });

    const answer = await loadWhatsDifferent(ddb, 'hh-1', NOW, DEFAULT_POLICY);

    expect(answer).toMatchObject({ weeksObserved: 1, enoughHistory: false, differences: [] });
    expect(answer.summary).toBe('Wick has been here for one week. It needs three weeks before it knows what is usual, so it cannot yet say what is different.');
  });

  it('says nothing about a visitor when the resident keeps visitors private — and does not even read who they are', async () => {
    const policy = { ...DEFAULT_POLICY, residentExclusions: ['PRESENCE' as const] };
    const { ddb, rosterReads } = table(sixWeeksOfMaria, { policy });

    const answer = await loadWhatsDifferent(ddb, 'hh-1', NOW, policy);

    expect(answer.differences).toEqual([]);
    expect(answer.keptPrivate).toEqual(['Who visits, by name. That is something the resident keeps to themselves.']);
    expect(rosterReads).toEqual([]);
  });

  it('keeps the door private on its own: the visitor is still said, the night call is not', async () => {
    const policy = { ...DEFAULT_POLICY, residentExclusions: ['DOOR_EVENT' as const] };
    const inTheNight = doorCall(FRIDAY + 1 * HOUR + 10 * 60_000);
    const { ddb } = table([...sixWeeksOfMaria, inTheNight], { policy });

    const answer = await loadWhatsDifferent(ddb, 'hh-1', NOW, policy);

    expect(answer.differences.map((d) => d.kind)).toEqual(['missed_visit']);
    expect(answer.keptPrivate).toEqual(['When someone comes to the door. That is something the resident keeps to themselves.']);
  });

  it('asks for six weeks and a day of the timeline, no more', async () => {
    const { ddb } = table([]);

    await loadWhatsDifferent(ddb, 'hh-1', NOW, DEFAULT_POLICY);

    const ranges = (ddb.send as ReturnType<typeof vi.fn>).mock.calls
      .map(([cmd]) => (cmd as { input: { ExpressionAttributeValues?: Record<string, AttributeValue> } }).input.ExpressionAttributeValues)
      .filter((v) => v?.[':from']);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]![':from']!.S).toBe(`EVT#${padTimestamp(NOW.getTime() - 43 * DAY)}`);
  });
});

describe('registerGetWhatsDifferent (registered tool handler, end to end)', () => {
  it('answers with the sentence to say and the same answer as structured content', async () => {
    const { ddb } = table(sixWeeksOfMaria);
    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerGetWhatsDifferent(mcpServer, ddb, allowedContext('hh-1'), () => NOW);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const listed = (await client.listTools()).tools.find((t) => t.name === 'get_whats_different');
    expect(listed?.annotations).toMatchObject({ readOnlyHint: true });

    const result = await client.callTool({ name: 'get_whats_different', arguments: {} });
    const content = result.content as { type: string; text: string }[];
    const said = JSON.parse(content[0]!.text) as { summary: string };
    expect(said.summary).toBe('Maria usually comes on Friday mornings. There has been no visit today. Nothing else is different from the usual.');
    expect(result.structuredContent).toEqual(said);
  });
});
