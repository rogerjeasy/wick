/**
 * Reconcile — what a television is handed when it asks for what it is owed
 * (device-event.mjs), and what happens to a card that stops being hers to
 * answer in the instant it is being handed over.
 *
 * Every reconnect goes through this. The cards are read, then sent one by
 * one; a card answered on another television of the home — or taken back by
 * its sender, or a door card whose visitor has gone — between that reading
 * and its sending used to stay on this television until its next reconnect.
 * Now the rows are read once more after the replay, and anything just sent
 * that is finished by then is taken back.
 *
 * The table and the bus are in memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Value = { S?: string; N?: string; BOOL?: boolean };
type Row = Record<string, Value>;

const aws = vi.hoisted(() => {
  process.env.TABLE_NAME = 'wick';
  process.env.EVENT_BUS_NAME = 'wick-bus';
  return {
    rows: new Map<string, Record<string, { S?: string; N?: string; BOOL?: boolean }>>(),
    sent: [] as { name: string; input: Record<string, unknown> }[],
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
      aws.sent.push({ name: cmd.name, input: cmd.input });
      if (cmd.name === 'Get') return { Item: aws.rows.get(keyOf(cmd.input.Key as Row)) };
      // The one update a reconcile makes is a television's "signalled lately" claim: refused, which the handler takes quietly.
      if (cmd.name === 'Update') throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
      if (cmd.name !== 'Query') throw new Error(`this table was not expecting a ${cmd.name}`);
      const values = cmd.input.ExpressionAttributeValues as Row;
      const mine = [...aws.rows.values()].filter((row) => row.pk!.S === values[':pk']!.S).sort((a, b) => (a.sk!.S! < b.sk!.S! ? -1 : 1));
      const Items = values[':prefix']
        ? mine.filter((row) => row.sk!.S!.startsWith(values[':prefix']!.S!))
        : mine.filter((row) => row.sk!.S! >= values[':from']!.S! && row.sk!.S! <= values[':to']!.S!);
      return { Items };
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
    async send() {
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
const T0 = Date.UTC(2026, 9, 13, 10, 0, 0);
const put = (item: Row) => aws.rows.set(`${item.pk!.S}|${item.sk!.S}`, item);
const rowKey = (cardId: string) => `${HH}|CARD#${cardId}`;

const note = (id: string, queuedAt: number) => ({ id, urgency: 'DEFERRED', queuedAt, shownCount: 0, card: { type: 'MESSAGE', id, householdId: 'hh-1', correlationId: 'c', createdAt: 1, fromName: 'Sarah', transcript: `About ${id}.`, suggestedReplies: ['I will'], actions: [] } });
const doorCard = (id: string, expiresAt: number) => ({ id, urgency: 'DOOR', queuedAt: T0 - 1000, expiresAt, shownCount: 0, card: { type: 'DOOR', id, householdId: 'hh-1', correlationId: 'c', createdAt: 1, line: "Someone's at the front door.", actions: [] } });
const store = (queued: { id: string }, extra: Row = {}) => put({ pk: { S: HH }, sk: { S: `CARD#${queued.id}` }, data: { S: JSON.stringify(queued) }, ...extra });

type Message = { readonly kind: 'card'; readonly card: { id: string } } | { readonly kind: 'control'; readonly control: Record<string, unknown> };

/** A reconcile from one television. `whenSent` is called as each card is handed over: what happens elsewhere in that instant. */
async function reconcile(options: { readonly holding?: readonly string[]; readonly whenSent?: (cardId: string) => void; readonly goneAfter?: number } = {}) {
  const messages: Message[] = [];
  const result = await handleDeviceEvent({
    householdId: 'hh-1',
    deviceId: 'tv-1',
    deviceEvent: { t: 'reconcile', at: 1, ...(options.holding ? { holding: options.holding } : {}) },
    sendCard: async (card: { id: string }) => {
      if (options.goneAfter !== undefined && messages.length >= options.goneAfter) return false;
      messages.push({ kind: 'card', card });
      options.whenSent?.(card.id);
      return true;
    },
    sendControl: async (control: Record<string, unknown>) => { messages.push({ kind: 'control', control }); return true; },
  });
  const cardReads = aws.sent.filter((call) => call.name === 'Query' && (call.input.ExpressionAttributeValues as Row)[':prefix']?.S === 'CARD#');
  return {
    result,
    messages,
    bytes: JSON.stringify(messages),
    cardReads,
    said: messages.map((message) => (message.kind === 'card' ? `card ${message.card.id}` : `${String(message.control.t)}${message.control.cardId ? ` ${String(message.control.cardId)}` : ''}`)),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  aws.rows.clear();
  aws.sent.length = 0;
  put({ pk: { S: HH }, sk: { S: 'DEV#tv-1' } });
  put({ pk: { S: HH }, sk: { S: 'META' } });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('an ordinary reconcile — nothing changes while the cards are handed over', () => {
  it('sends, to the byte, what it always sent — each card as it is stored, then the home — and nothing more', async () => {
    const a = note('note-a', 10);
    const b = note('note-b', 20);
    const door = doorCard('door-1', T0 + 60_000);
    store(a);
    store(b, { shown: { N: '1' } });
    store(door);

    const tv = await reconcile();

    expect(tv.result).toEqual({ statusCode: 200, body: '' });
    expect(tv.bytes).toBe(
      JSON.stringify([
        { kind: 'card', card: door },
        { kind: 'card', card: a },
        { kind: 'card', card: { ...b, shownCount: 1 } },
        { kind: 'control', control: { t: 'home', home: {}, whole: true } },
      ]),
    );
  });

  it('still takes back, first, what the television says it holds that was answered while it was away', async () => {
    store(note('note-a', 10), { actedAt: { N: '5' } });
    store(note('note-b', 20));

    const tv = await reconcile({ holding: ['note-a', 'note-b', 'note-unknown'] });

    expect(tv.said).toEqual(['revoke note-a', 'card note-b', 'home']);
  });

  it('reads the cards as they are that instant, and once more after handing them over — one read each time, not one a card', async () => {
    for (let i = 0; i < 12; i += 1) store(note(`note-${String(i).padStart(2, '0')}`, i));

    const tv = await reconcile();

    expect(tv.cardReads).toHaveLength(2);
    for (const read of tv.cardReads) expect(read.input.ConsistentRead).toBe(true);
    expect(tv.messages.filter((message) => message.kind === 'card')).toHaveLength(12);
    expect(aws.sent.filter((call) => call.name === 'Get' && String((call.input.Key as Row).sk!.S).startsWith('CARD#'))).toEqual([]);
  });

  it('does not read again when there was nothing to hand over', async () => {
    store(note('note-a', 10), { actedAt: { N: '5' } });

    const tv = await reconcile({ holding: ['note-a'] });

    expect(tv.said).toEqual(['revoke note-a', 'home']);
    expect(tv.cardReads).toHaveLength(1);
  });
});

describe('a card that stops being hers to answer while it is being handed over', () => {
  beforeEach(() => {
    store(note('note-a', 10));
    store(note('note-b', 20));
    store(note('note-c', 30));
  });

  it('answered on another television in that instant: it was already read, so it is handed over — and then taken back, before the home is told', async () => {
    const tv = await reconcile({
      // As the first card goes out, she answers the last one in another room.
      whenSent: (cardId) => { if (cardId === 'note-a') put({ ...aws.rows.get(rowKey('note-c'))!, actedAt: { N: String(T0) } }); },
    });

    expect(tv.said).toEqual(['card note-a', 'card note-b', 'card note-c', 'revoke note-c', 'home']);
  });

  it('taken back by its sender in that instant — its row gone: taken back here too', async () => {
    const tv = await reconcile({ whenSent: (cardId) => { if (cardId === 'note-a') aws.rows.delete(rowKey('note-b')); } });

    expect(tv.said).toEqual(['card note-a', 'card note-b', 'card note-c', 'revoke note-b', 'home']);
  });

  it('a door card whose visitor goes in that instant: taken back', async () => {
    store(doorCard('door-1', T0 + 500));

    const tv = await reconcile({ whenSent: (cardId) => { if (cardId === 'note-c') vi.setSystemTime(T0 + 500); } });

    expect(tv.said).toEqual(['card door-1', 'card note-a', 'card note-b', 'card note-c', 'revoke door-1', 'home']);
  });

  it('several at once: each is taken back once, in the order they were handed over', async () => {
    const tv = await reconcile({
      holding: ['note-a'],
      whenSent: (cardId) => {
        if (cardId !== 'note-c') return;
        put({ ...aws.rows.get(rowKey('note-a'))!, actedAt: { N: String(T0) } });
        aws.rows.delete(rowKey('note-c'));
      },
    });

    expect(tv.said).toEqual(['card note-a', 'card note-b', 'card note-c', 'revoke note-a', 'revoke note-c', 'home']);
  });

  it('a card that only changed — a showing counted, a translation kept beside it — is left where it is', async () => {
    const tv = await reconcile({ whenSent: (cardId) => { if (cardId === 'note-a') put({ ...aws.rows.get(rowKey('note-b'))!, shown: { N: '2' }, tr_es: { S: '{"transcript":"Hola."}' } }); } });

    expect(tv.said).toEqual(['card note-a', 'card note-b', 'card note-c', 'home']);
  });

  it('stops, as before, when the television has gone mid-replay: nothing is read again for one that is not there', async () => {
    const tv = await reconcile({ goneAfter: 1 });

    expect(tv.said).toEqual(['card note-a', 'home']);
    expect(tv.cardReads).toHaveLength(1);
  });
});
