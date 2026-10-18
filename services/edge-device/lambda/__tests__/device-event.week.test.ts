/**
 * Her press of OK on the week card (device-event.mjs): it sets
 * residentSeenAt — INV-7's gate — and, the first time only, tells the agent
 * plane the week can now be read, so the family is nudged that it is there
 * (services/agent brief/weekReady.ts). The table and the bus are in memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Value = { S?: string; N?: string; BOOL?: boolean };
type Row = Record<string, Value>;

const aws = vi.hoisted(() => {
  process.env.TABLE_NAME = 'wick';
  process.env.EVENT_BUS_NAME = 'wick-bus';
  return {
    rows: new Map<string, Record<string, { S?: string; N?: string; BOOL?: boolean }>>(),
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
      // The press's own bookkeeping — marking its card acted on, a claim — is not what is under test.
      if (cmd.name === 'Update') throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
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
const week = (seenAt?: number) => ({ householdId: 'hh-1', isoWeek: '2026-W38', text: 'A quiet week.', deltas: [], timeline: [], generatedAt: 1, ...(seenAt ? { residentSeenAt: seenAt } : {}) });

/** The edge is told of the press at `at`: its own clock is what dates it (device-event.mjs onTheEdgeClock). */
const pressOk = (at: number) =>
  (vi.useFakeTimers({ toFake: ['Date'] }), vi.setSystemTime(at), handleDeviceEvent({
    householdId: 'hh-1',
    deviceId: 'tv-1',
    deviceEvent: { t: 'card_action', cardId: 'week-2026-W38', action: 'seen', at },
    sendCard: async () => true,
    sendControl: async () => true,
  }));

const weekSeen = () => aws.events.filter((e) => e.DetailType === 'week.seen');

beforeEach(() => {
  aws.rows.clear();
  aws.events.length = 0;
  put({ pk: { S: HH }, sk: { S: 'DEV#tv-1' } });
  put({ pk: { S: HH }, sk: { S: 'META' } });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OK on the week card', () => {
  it('marks the week read, then tells the agent plane the week can be read — the household, the week, when, and nothing she read', async () => {
    put({ pk: { S: HH }, sk: { S: 'NARR#2026-W38' }, data: { S: JSON.stringify(week()) } });

    await pressOk(5000);

    expect(JSON.parse(aws.rows.get(`${HH}|NARR#2026-W38`)!.data!.S!).residentSeenAt).toBe(5000);
    expect(weekSeen()).toEqual([{ EventBusName: 'wick-bus', Source: 'wick.device', DetailType: 'week.seen', Detail: JSON.stringify({ householdId: 'hh-1', isoWeek: '2026-W38', at: 5000 }) }]);
  });

  it('says nothing the second time: the week was already readable, and the family already told', async () => {
    put({ pk: { S: HH }, sk: { S: 'NARR#2026-W38' }, data: { S: JSON.stringify(week(4000)) } });

    await pressOk(5000);

    expect(JSON.parse(aws.rows.get(`${HH}|NARR#2026-W38`)!.data!.S!).residentSeenAt).toBe(4000);
    expect(weekSeen()).toEqual([]);
  });

  it('says nothing for a week that was never written', async () => {
    await pressOk(5000);
    expect(weekSeen()).toEqual([]);
  });
});
