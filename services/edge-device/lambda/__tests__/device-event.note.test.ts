/**
 * Back on a family note (device-event.mjs): "later". The note is not
 * answered, so it is not finished and no reply is recorded; it is stamped
 * as seen, with its two showings, so it waits on her home screen and no
 * television brings it to her again (note-reply.mjs markNoteSeen). The
 * table and the bus are in memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Value = { S?: string; N?: string; BOOL?: boolean };
type Row = Record<string, Value>;

const aws = vi.hoisted(() => {
  process.env.TABLE_NAME = 'wick';
  process.env.EVENT_BUS_NAME = 'wick-bus';
  return {
    rows: new Map<string, Record<string, { S?: string; N?: string; BOOL?: boolean }>>(),
    updates: [] as { UpdateExpression: string; Key: Row; ExpressionAttributeValues: Row }[],
    events: [] as { DetailType: string; Detail: string }[],
  };
});

vi.mock('@aws-sdk/client-dynamodb', () => {
  const command = (name: string) =>
    class {
      readonly name = name;
      constructor(readonly input: Record<string, unknown>) {}
    };
  const keyOf = (key: Row) => `${key.pk!.S}|${key.sk!.S}`;
  class DynamoDBClient {
    async send(cmd: { name: string; input: Record<string, unknown> }) {
      if (cmd.name === 'Get') return { Item: aws.rows.get(keyOf(cmd.input.Key as Row)) };
      if (cmd.name === 'Put') {
        const item = cmd.input.Item as Row;
        aws.rows.set(keyOf(item), item);
        return {};
      }
      if (cmd.name === 'Update') {
        aws.updates.push(cmd.input as (typeof aws.updates)[number]);
        return {};
      }
      if (cmd.name === 'Query') return { Items: [] };
      throw new Error(`this table was not expecting a ${cmd.name}`);
    }
  }
  return {
    DynamoDBClient,
    GetItemCommand: command('Get'),
    PutItemCommand: command('Put'),
    QueryCommand: command('Query'),
    UpdateItemCommand: command('Update'),
    TransactWriteItemsCommand: command('Transact'),
  };
});

vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: class {
    async send(cmd: { input: { Entries: { DetailType: string; Detail: string }[] } }) {
      aws.events.push(...cmd.input.Entries);
      return {};
    }
  },
  PutEventsCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

/** The phrasebook is not what is under test: every sentence comes back as it went. */
vi.mock('../phrasebook.generated.mjs', () => ({
  cardIn: (_language: string, card: unknown) => card,
  patchIn: (_language: string, patch: unknown) => patch,
  homeIn: (_language: string, home: unknown) => home,
}));

// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
const { handleDeviceEvent } = await import('../device-event.mjs');

const HH = 'HH#hh-1';
const put = (item: Row) => aws.rows.set(`${item.pk!.S}|${item.sk!.S}`, item);

/** The edge is told of the press at `at`: its own clock is what dates it (device-event.mjs onTheEdgeClock). */
const press = (action: string, at: number) =>
  (vi.useFakeTimers({ toFake: ['Date'] }), vi.setSystemTime(at), handleDeviceEvent({
    householdId: 'hh-1',
    deviceId: 'tv-1',
    deviceEvent: { t: 'card_action', cardId: 'note-1', action, at },
    sendCard: async () => true,
    sendControl: async () => true,
  }));

const onTheNote = () => aws.updates.filter((u) => u.Key.sk!.S === 'CARD#note-1').map((u) => u.UpdateExpression);

beforeEach(() => {
  aws.rows.clear();
  aws.updates.length = 0;
  aws.events.length = 0;
  put({ pk: { S: HH }, sk: { S: 'DEV#tv-1' } });
  put({ pk: { S: HH }, sk: { S: 'META' } });
  put({
    pk: { S: HH },
    sk: { S: 'CARD#note-1' },
    data: { S: JSON.stringify({ id: 'note-1', urgency: 'DEFERRED', queuedAt: 1, shownCount: 0, card: { type: 'MESSAGE', id: 'note-1', fromName: 'Sarah', transcript: 'Hello Mum', suggestedReplies: ['Thank you!', 'Not right now.'] } }) },
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a television's clock is not the time of her answer", () => {
  it('dates her reply by the edge: a television three hours slow does not make a reply look given before the note', async () => {
    const edgeNow = Date.UTC(2026, 9, 18, 15, 4);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(edgeNow);
    await handleDeviceEvent({
      householdId: 'hh-1',
      deviceId: 'tv-1',
      // The Vega Virtual Device's own clock, 3 h 12 min behind.
      deviceEvent: { t: 'card_action', cardId: 'note-1', action: 'reply_0', at: edgeNow - (3 * 60 + 12) * 60_000 },
      sendCard: async () => true,
      sendControl: async () => true,
    });

    const reply = aws.updates.find((u) => u.UpdateExpression.includes('repliedAt'));
    expect(reply?.ExpressionAttributeValues[':at']).toEqual({ N: String(edgeNow) });
  });

  it('still refuses an event that carries no time at all', async () => {
    const answer = await handleDeviceEvent({
      householdId: 'hh-1',
      deviceId: 'tv-1',
      deviceEvent: { t: 'card_action', cardId: 'note-1', action: 'reply_0' },
      sendCard: async () => true,
      sendControl: async () => true,
    });
    expect(answer).toMatchObject({ statusCode: 400 });
  });
});

describe('Back on a note: "later"', () => {
  it('stamps the note seen, with its two showings — and does not finish it, nor record a reply', async () => {
    await press('later', 5000);

    expect(onTheNote()).toEqual(['SET seenAt = if_not_exists(seenAt, :at), shown = :showings']);
    expect(aws.updates[0]!.ExpressionAttributeValues).toEqual({ ':at': { N: '5000' }, ':showings': { N: '2' } });
  });

  it('tells the agent plane nothing: nothing was answered', async () => {
    await press('later', 5000);

    expect(aws.events).toEqual([]);
  });

  it('leaves a reply as it was: answered, and finished', async () => {
    await press('reply_0', 5000);

    expect(onTheNote()).not.toContain('SET seenAt = if_not_exists(seenAt, :at), shown = :showings');
    expect(onTheNote()).toContain('SET actedAt = if_not_exists(actedAt, :at)');
  });
});
