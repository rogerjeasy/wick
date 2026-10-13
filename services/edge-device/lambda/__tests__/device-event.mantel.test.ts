/**
 * The mantelpiece — the edge's handler, whole (device-event.mjs): her two
 * presses on a picture's card, the mantelpiece she asks for, taking a thing
 * down, and what of all this anything else can see.
 *
 * The table, the bus and the bucket are in memory. The table's writes are
 * real enough to be raced: every call gives way before it runs, a
 * transaction is all or nothing, and conditions are checked against the
 * rows as they are at that moment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MANTEL_FULL_NOTICE, MAX_MANTEL, readHomeState, readMantelItems } from '@wick/contracts';

type Value = { S?: string; N?: string; BOOL?: boolean; SS?: string[] };
type Row = Record<string, Value>;
type Names = Record<string, string>;

const aws = vi.hoisted(() => {
  Object.assign(process.env, {
    TABLE_NAME: 'wick',
    EVENT_BUS_NAME: 'wick-bus',
    PHOTOS_BUCKET: 'wick-photos-test',
    AWS_ACCESS_KEY_ID: 'TEST-KEY-ID-NOT-A-REAL-ONE',
    AWS_SECRET_ACCESS_KEY: 'test/secret+key',
    AWS_SESSION_TOKEN: 'test-session-token',
    AWS_REGION: 'us-east-1',
  });
  return {
    rows: new Map<string, Record<string, { S?: string; N?: string; BOOL?: boolean; SS?: string[] }>>(),
    sent: [] as { name: string; input: Record<string, unknown> }[],
    events: [] as { DetailType: string; Detail: string }[],
    /** Every tag S3 was asked to put, in order. */
    tags: [] as { key: string; state: string }[],
    /** How S3 answers a retag — fine, or with this error — and how many times it was asked. */
    s3: { fails: undefined as string | { name: string; $metadata?: { httpStatusCode: number } } | undefined, asked: 0 },
  };
});

vi.mock('@aws-sdk/client-dynamodb', () => {
  const command = (name: string) =>
    class {
      readonly name = name;
      constructor(readonly input: Record<string, unknown>) {}
    };
  const keyOf = (key: Row) => `${key.pk!.S}|${key.sk!.S}`;
  const refused = () => Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });

  /** One condition, against one row as it is now. AND binds tighter than OR; there are no brackets but a function's own. */
  function holds(condition: string | undefined, row: Row | undefined, names: Names, values: Row): boolean {
    if (condition === undefined) return true;
    // A television's "signalled lately" claim is not these tests' business: refused, which the handler takes quietly.
    if (condition.includes('activeSignalAt')) return false;
    const attr = (name: string) => row?.[names[name] ?? name];
    const atom = (text: string): boolean => {
      const exists = /^attribute_(not_)?exists\((#?\w+)\)$/.exec(text);
      if (exists) return exists[1] ? attr(exists[2]!) === undefined : attr(exists[2]!) !== undefined;
      const compare = /^(#?\w+) (=|<|>) (:\w+)$/.exec(text);
      if (!compare) throw new Error(`a condition this table does not know: ${text}`);
      const have = attr(compare[1]!);
      const want = values[compare[3]!]!;
      if (have === undefined) return false;
      if (compare[2] === '=') return (have.S ?? have.N) === (want.S ?? want.N);
      return compare[2] === '<' ? Number(have.N) < Number(want.N) : Number(have.N) > Number(want.N);
    };
    return condition.split(' OR ').some((all) => all.split(' AND ').every((one) => atom(one.trim())));
  }

  /** SET, REMOVE and ADD, as the handler writes them. */
  function applied(row: Row, expression: string, names: Names, values: Row): Row {
    const next: Row = { ...row };
    const attr = (name: string) => names[name] ?? name;
    for (const [, verb, body] of expression.matchAll(/(SET|REMOVE|ADD) (.*?)(?= (?:SET|REMOVE|ADD) |$)/g)) {
      // A comma inside if_not_exists(…) does not end an assignment.
      for (const part of body!.split(/,(?![^(]*\))/).map((text) => text.trim()).filter(Boolean)) {
        if (verb === 'REMOVE') {
          delete next[attr(part)];
        } else if (verb === 'ADD') {
          const [name, value] = part.split(/\s+/) as [string, string];
          next[attr(name)] = { N: String(Number(next[attr(name)]?.N ?? 0) + Number(values[value]!.N)) };
        } else {
          const [name, right] = part.split(/=(.*)/).map((text) => text.trim()) as [string, string];
          const once = /^if_not_exists\((#?\w+), (:\w+)\)$/.exec(right);
          next[attr(name)] = once ? (next[attr(once[1]!)] ?? values[once[2]!]!) : values[right]!;
        }
      }
    }
    return next;
  }

  type Write = { Key?: Row; Item?: Row; UpdateExpression?: string; ConditionExpression?: string; ExpressionAttributeNames?: Names; ExpressionAttributeValues?: Row };
  const target = (write: Write) => keyOf(write.Key ?? write.Item!);
  const allowed = (write: Write) => holds(write.ConditionExpression, aws.rows.get(target(write)), write.ExpressionAttributeNames ?? {}, write.ExpressionAttributeValues ?? {});
  const carryOut = (write: Write) => {
    if (write.Item) aws.rows.set(target(write), write.Item);
    else aws.rows.set(target(write), applied(aws.rows.get(target(write)) ?? write.Key!, write.UpdateExpression!, write.ExpressionAttributeNames ?? {}, write.ExpressionAttributeValues ?? {}));
  };

  class DynamoDBClient {
    async send(cmd: { name: string; input: Record<string, unknown> }) {
      // Give way first: two televisions pressing at once really do interleave.
      await new Promise((resolve) => setTimeout(resolve, 0));
      aws.sent.push({ name: cmd.name, input: cmd.input });

      if (cmd.name === 'Get') return { Item: aws.rows.get(keyOf(cmd.input.Key as Row)) };
      if (cmd.name === 'Put' || cmd.name === 'Update') {
        if (!allowed(cmd.input as Write)) throw refused();
        carryOut(cmd.input as Write);
        return {};
      }
      if (cmd.name === 'Transact') {
        const writes = (cmd.input.TransactItems as { Put?: Write; Update?: Write }[]).map((item) => (item.Put ?? item.Update)!);
        const verdicts = writes.map(allowed);
        if (verdicts.some((ok) => !ok)) {
          throw Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException', CancellationReasons: verdicts.map((ok) => ({ Code: ok ? 'None' : 'ConditionalCheckFailed' })) });
        }
        writes.forEach(carryOut);
        return {};
      }
      // Query: a prefix, or a range between two sort keys, of one household's rows.
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
    async send(cmd: { input: { Entries: { DetailType: string; Detail: string }[] } }) {
      aws.events.push(...cmd.input.Entries);
      return {};
    }
  },
  PutEventsCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    async send(cmd: { input: { Bucket: string; Key: string; Tagging: { TagSet: { Key: string; Value: string }[] } } }) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      aws.s3.asked += 1;
      if (aws.s3.fails) throw Object.assign(new Error('s3'), typeof aws.s3.fails === 'string' ? { name: aws.s3.fails } : aws.s3.fails);
      expect(cmd.input.Bucket).toBe('wick-photos-test');
      aws.tags.push({ key: cmd.input.Key, state: cmd.input.Tagging.TagSet.map((tag) => `${tag.Key}=${tag.Value}`).join('&') });
      return {};
    }
  },
  PutObjectTaggingCommand: class {
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
const row = (sk: string) => aws.rows.get(`${HH}|${sk}`);
const put = (item: Row) => aws.rows.set(`${item.pk!.S}|${item.sk!.S}`, item);

const photoCard = (photoId: string, fromName = 'Sarah Hughes') => ({
  id: `photo-${photoId}`,
  urgency: 'DEFERRED',
  queuedAt: 10,
  shownCount: 0,
  card: {
    type: 'PHOTO',
    id: `photo-${photoId}`,
    householdId: 'hh-1',
    correlationId: `corr-${photoId}`,
    createdAt: 10,
    photoId,
    fromName,
    headline: 'A picture from Sarah.',
    actions: [
      { id: 'keep', label: 'Keep it', kind: 'primary' },
      { id: 'thanks', label: 'Thank you', kind: 'secondary' },
    ],
  },
});

/** A picture as the Wick server leaves it: its own row, and its card. */
function sent(photoId: string, fromName?: string) {
  put({ pk: { S: HH }, sk: { S: `PHOTO#${photoId}` }, fromUserId: { S: 'u1' }, sentAt: { N: '10' } });
  put({ pk: { S: HH }, sk: { S: `CARD#photo-${photoId}` }, data: { S: JSON.stringify(photoCard(photoId, fromName)) } });
}

/** A mantelpiece that already holds this many things, counted. */
function holding(count: number) {
  for (let i = 0; i < count; i += 1) {
    put({ pk: { S: HH }, sk: { S: `MANTEL#old${i}` }, photoId: { S: `old${i}` }, fromName: { S: 'Tom' }, keptAt: { N: String(100 + i) } });
  }
  put({ pk: { S: HH }, sk: { S: 'MANTEL' }, count: { N: String(count) } });
}

const onTheMantel = () => [...aws.rows.values()].filter((item) => item.sk!.S!.startsWith('MANTEL#') && !item.downAt).map((item) => item.sk!.S!.slice('MANTEL#'.length));

async function television(deviceEvent: Record<string, unknown>, deviceId = 'tv-1') {
  const cards: { id: string; card: Record<string, unknown>; shownCount: number; respondsTo?: string }[] = [];
  const controls: Record<string, unknown>[] = [];
  const result = await handleDeviceEvent({
    householdId: 'hh-1',
    deviceId,
    deviceEvent,
    sendCard: async (card: (typeof cards)[number]) => { cards.push(card); return true; },
    sendControl: async (control: Record<string, unknown>) => { controls.push(control); return true; },
  });
  return { result, cards, controls };
}

const press = (photoId: string, action: string, deviceId?: string) => television({ t: 'card_action', cardId: `photo-${photoId}`, action, at: 1_000 }, deviceId);
const busOf = (type: string) => aws.events.filter((entry) => entry.DetailType === type).map((entry) => JSON.parse(entry.Detail));
const addressOf = (url: unknown) => new URL(String(url));

let said: string[] = [];

beforeEach(() => {
  aws.rows.clear();
  aws.sent.length = 0;
  aws.events.length = 0;
  aws.tags.length = 0;
  aws.s3.fails = undefined;
  aws.s3.asked = 0;
  said = [];
  for (const method of ['log', 'error', 'warn', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { said.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')); });
  }
  put({ pk: { S: HH }, sk: { S: 'DEV#tv-1' } });
  put({ pk: { S: HH }, sk: { S: 'DEV#tv-2' } });
  put({ pk: { S: HH }, sk: { S: 'META' } });
});

afterEach(() => {
  // Whatever happened, nothing that was said aloud names a picture's address.
  expect(said.join('\n')).not.toMatch(/X-Amz|https:\/\/|amazonaws/);
  vi.restoreAllMocks();
});

describe('"Keep it" — with room', () => {
  it('puts the picture on her mantelpiece, under the sender’s first name from the stored card, at this server’s time', async () => {
    sent('p1', 'Sarah Hughes');
    const before = Date.now();

    await press('p1', 'keep');

    const kept = row('MANTEL#p1')!;
    expect({ photoId: kept.photoId, fromName: kept.fromName }).toEqual({ photoId: { S: 'p1' }, fromName: { S: 'Sarah' } });
    expect(Number(kept.keptAt!.N)).toBeGreaterThanOrEqual(before);
    expect(Object.keys(kept).sort()).toEqual(['fromName', 'keptAt', 'photoId', 'pk', 'sk']);
    expect(row('MANTEL')!.count).toEqual({ N: '1' });
  });

  it('says she has seen it, tells the bucket to keep it, and finishes the card as any answered card is finished', async () => {
    sent('p1');

    const tv = await press('p1', 'keep');

    expect(row('PHOTO#p1')!.seenAt).toBeDefined();
    expect(aws.tags).toEqual([{ key: 'photos/hh-1/p1.jpg', state: 'state=kept' }]);
    expect(row('CARD#photo-p1')!.actedAt).toBeDefined();
    // Nothing comes back as a card: it has been put away.
    expect(tv.cards).toEqual([]);
    // A second television in the home is told to put it away, as for any card.
    expect(busOf('card.retired')).toEqual([expect.objectContaining({ householdId: 'hh-1', deviceId: 'tv-1', cardId: 'photo-p1' })]);
  });

  it('tells every home screen the count: this television at once, the others through the bus — a number, and nothing of the picture', async () => {
    sent('p1');

    const tv = await press('p1', 'keep');

    expect(tv.controls).toEqual([{ t: 'home', home: { mantel: 1 }, whole: true }]);
    const [changed] = busOf('home.changed');
    expect(readHomeState(changed.home)).toEqual({ mantel: 1 });
    expect(JSON.stringify(aws.events)).not.toMatch(/https:|X-Amz|fromName|Sarah/);
  });

  it('keeps the one that fills the last place', async () => {
    holding(MAX_MANTEL - 1);
    sent('p1');

    const tv = await press('p1', 'keep');

    expect(onTheMantel()).toHaveLength(MAX_MANTEL);
    expect(row('MANTEL')!.count).toEqual({ N: String(MAX_MANTEL) });
    expect(tv.controls).toEqual([{ t: 'home', home: { mantel: MAX_MANTEL }, whole: true }]);
  });
});

describe('"Keep it" — when her mantelpiece is full', () => {
  beforeEach(() => {
    holding(MAX_MANTEL);
    sent('p1');
  });

  it('keeps nothing, and the card is not finished', async () => {
    await press('p1', 'keep');

    expect(onTheMantel()).toHaveLength(MAX_MANTEL);
    expect(row('MANTEL#p1')).toBeUndefined();
    expect(row('MANTEL')!.count).toEqual({ N: String(MAX_MANTEL) });
    expect(row('CARD#photo-p1')!.actedAt).toBeUndefined();
    expect(busOf('card.retired')).toEqual([]);
    // The bucket is told nothing: the picture is as it was, still to be answered.
    expect(aws.tags).toEqual([]);
  });

  it('still says she has seen it — she has', async () => {
    await press('p1', 'keep');

    expect(row('PHOTO#p1')!.seenAt).toBeDefined();
  });

  it('sends the card back to the television that pressed, saying there is no room, with a fresh address — to be shown at once', async () => {
    const tv = await press('p1', 'keep');

    expect(tv.cards).toHaveLength(1);
    const [back] = tv.cards;
    expect(back!.id).toBe('photo-p1');
    expect(back!.card.notice).toBe(MANTEL_FULL_NOTICE);
    expect(back!.respondsTo).toBe('photo-p1');
    expect(back!.shownCount).toBe(0);
    expect(addressOf(back!.card.photoUrl).pathname).toBe('/photos/hh-1/p1.jpg');
    // The home screen has not changed: nothing to tell.
    expect(tv.controls).toEqual([]);
    expect(busOf('home.changed')).toEqual([]);
  });

  it('leaves the stored card exactly as the server wrote it: no notice, no address', async () => {
    const before = row('CARD#photo-p1')!.data!.S;

    await press('p1', 'keep');

    expect(row('CARD#photo-p1')!.data!.S).toBe(before);
    expect(JSON.stringify([...aws.rows.values()])).not.toMatch(/X-Amz|photoUrl|amazonaws/);
  });

  it('and once she has taken one down, the same press keeps it', async () => {
    await press('p1', 'keep');
    expect(row('MANTEL#p1')).toBeUndefined();

    await television({ t: 'mantel_take_down', photoId: 'old3', at: 2_000 });
    const tv = await press('p1', 'keep');

    expect(onTheMantel()).toHaveLength(MAX_MANTEL);
    expect(onTheMantel()).toContain('p1');
    expect(onTheMantel()).not.toContain('old3');
    expect(row('CARD#photo-p1')!.actedAt).toBeDefined();
    expect(tv.cards).toEqual([]);
  });
});

describe('two pictures kept at the same moment, with one place left', () => {
  it('cannot both take it: one is kept, the other is told there is no room', async () => {
    holding(MAX_MANTEL - 1);
    sent('p1');
    sent('p2');

    const [first, second] = await Promise.all([press('p1', 'keep', 'tv-1'), press('p2', 'keep', 'tv-2')]);

    expect(onTheMantel()).toHaveLength(MAX_MANTEL);
    expect(row('MANTEL')!.count).toEqual({ N: String(MAX_MANTEL) });
    const keptOnes = ['p1', 'p2'].filter((id) => onTheMantel().includes(id));
    expect(keptOnes).toHaveLength(1);
    const [winner] = keptOnes;
    const loser = winner === 'p1' ? 'p2' : 'p1';
    const lost = winner === 'p1' ? second : first;

    expect(lost.cards.map((card) => [card.id, card.card.notice])).toEqual([[`photo-${loser}`, MANTEL_FULL_NOTICE]]);
    expect(row(`CARD#photo-${winner}`)!.actedAt).toBeDefined();
    expect(row(`CARD#photo-${loser}`)!.actedAt).toBeUndefined();
    // The bucket ends up keeping the one she has, and the other as it was: still to be answered.
    const last = (id: string) => aws.tags.filter((tag) => tag.key === `photos/hh-1/${id}.jpg`).at(-1)?.state;
    expect(last(winner!)).toBe('state=kept');
    expect(last(loser)).toBe('state=sent');
  });

  it('holds for many at once: never more than a mantelpiece holds', async () => {
    holding(MAX_MANTEL - 2);
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    ids.forEach((id) => sent(id));

    await Promise.all(ids.map((id) => press(id, 'keep')));

    expect(onTheMantel()).toHaveLength(MAX_MANTEL);
    expect(row('MANTEL')!.count).toEqual({ N: String(MAX_MANTEL) });
    expect(ids.filter((id) => row(`CARD#photo-${id}`)!.actedAt)).toHaveLength(2);
  });
});

describe('"Thank you"', () => {
  it('says she has seen it, lets the bucket let go of it, finishes the card — and nothing else', async () => {
    sent('p1');

    const tv = await press('p1', 'thanks');

    expect(row('PHOTO#p1')!.seenAt).toBeDefined();
    expect(aws.tags).toEqual([{ key: 'photos/hh-1/p1.jpg', state: 'state=gone' }]);
    expect(row('CARD#photo-p1')!.actedAt).toBeDefined();
    expect(busOf('card.retired').map((detail) => detail.cardId)).toEqual(['photo-p1']);
    expect(onTheMantel()).toEqual([]);
    expect(row('MANTEL')).toBeUndefined();
    expect(tv.cards).toEqual([]);
    expect(tv.controls).toEqual([]);
    expect(busOf('home.changed')).toEqual([]);
  });
});

describe('THE RULE — kept and not kept look exactly the same from outside', () => {
  /** Everything a family tool could read of one picture, after one press. */
  async function outside(action: 'keep' | 'thanks') {
    aws.rows.clear();
    aws.events.length = 0;
    put({ pk: { S: HH }, sk: { S: 'DEV#tv-1' } });
    put({ pk: { S: HH }, sk: { S: 'META' } });
    sent('p1');
    await press('p1', action);

    const shape = (item: Row | undefined) => Object.keys(item ?? {}).sort();
    const timeline = [...aws.rows.values()].filter((item) => item.sk!.S!.startsWith('EVT#')).map((item) => ({ ...item, sk: 'EVT#…' }));
    return {
      picture: shape(row('PHOTO#p1')),
      card: shape(row('CARD#photo-p1')),
      cardData: row('CARD#photo-p1')!.data!.S,
      timeline,
      retired: busOf('card.retired').map(({ at: _when, ...rest }) => rest),
      toTheAgentPlane: busOf('card.action'),
    };
  }

  it('the picture’s row, its card, the timeline and what is said on the bus about the card do not tell which button it was', async () => {
    const kept = await outside('keep');
    const thanked = await outside('thanks');

    expect(kept).toEqual(thanked);
    expect(kept.picture).toEqual(['fromUserId', 'pk', 'seenAt', 'sentAt', 'sk']);
  });

  it('the press goes on the timeline without its button', async () => {
    sent('p1');
    await press('p1', 'keep');

    const [pressed] = [...aws.rows.values()].filter((item) => item.sk!.S!.startsWith('EVT#'));
    expect(pressed).toMatchObject({ type: { S: 'card_action' }, cardId: { S: 'photo-p1' } });
    expect(pressed).not.toHaveProperty('action');
    expect(JSON.stringify(pressed)).not.toMatch(/keep|thanks/);
  });

  it('and every other card’s press still goes on it with its button, as it always did', async () => {
    put({ pk: { S: HH }, sk: { S: 'CARD#note-1' }, data: { S: JSON.stringify({ id: 'note-1', urgency: 'DEFERRED', card: { type: 'MESSAGE', id: 'note-1', suggestedReplies: ['I will'] } }) } });

    await television({ t: 'card_action', cardId: 'note-1', action: 'reply_0', at: 1_000 });

    const [pressed] = [...aws.rows.values()].filter((item) => item.sk!.S!.startsWith('EVT#'));
    expect(pressed!.action).toEqual({ S: 'reply_0' });
  });

  it('neither press is handed to the agent plane, and nothing said aloud tells them apart', async () => {
    sent('p1');
    sent('p2');
    await press('p1', 'keep');
    const afterKeep = said.filter((line) => /photo/i.test(line));
    said = [];
    await press('p2', 'thanks');
    const afterThanks = said.filter((line) => /photo/i.test(line));

    expect(busOf('card.action')).toEqual([]);
    expect(afterKeep).toEqual(afterThanks);
    expect([...afterKeep, ...afterThanks].join('\n')).not.toMatch(/keep|kept|thanks|p1|p2/);
  });
});

describe('a press that no longer counts', () => {
  it('"Thank you" on a picture she has kept changes nothing: it stays on her mantelpiece, and the bucket goes on keeping it', async () => {
    sent('p1');
    await press('p1', 'keep');
    aws.tags.length = 0;
    const before = JSON.stringify([...aws.rows.entries()].filter(([key]) => !key.includes('EVT#')));

    await press('p1', 'thanks', 'tv-2');

    expect(JSON.stringify([...aws.rows.entries()].filter(([key]) => !key.includes('EVT#')))).toBe(before);
    expect(onTheMantel()).toEqual(['p1']);
    expect(aws.tags).toEqual([]);
  });

  it('"Keep it" on a picture she has thanked for changes nothing', async () => {
    sent('p1');
    await press('p1', 'thanks');
    aws.tags.length = 0;

    const tv = await press('p1', 'keep', 'tv-2');

    expect(onTheMantel()).toEqual([]);
    expect(row('MANTEL')).toBeUndefined();
    expect(aws.tags).toEqual([]);
    expect(tv.cards).toEqual([]);
  });

  it('"Keep it" pressed on two televisions at once keeps it once', async () => {
    sent('p1');

    await Promise.all([press('p1', 'keep', 'tv-1'), press('p1', 'keep', 'tv-2')]);

    expect(onTheMantel()).toEqual(['p1']);
    expect(row('MANTEL')!.count).toEqual({ N: '1' });
    expect(aws.tags.at(-1)).toEqual({ key: 'photos/hh-1/p1.jpg', state: 'state=kept' });
  });

  it('"Keep it" on one television and "Thank you" on another: one answer counts, and the bucket is told that one', async () => {
    sent('p1');

    await Promise.all([press('p1', 'keep', 'tv-1'), press('p1', 'thanks', 'tv-2')]);

    const keptIt = onTheMantel().includes('p1');
    expect(row('MANTEL')?.count?.N ?? '0').toBe(keptIt ? '1' : '0');
    expect(aws.tags.at(-1)!.state).toBe(keptIt ? 'state=kept' : 'state=gone');
    expect(row('CARD#photo-p1')!.actedAt).toBeDefined();
  });

  it('a press that is neither of its two buttons does nothing to a picture’s card: it is not finished, not seen, not taken off the other televisions', async () => {
    sent('p1');

    for (const action of ['dismiss', 'seen', 'allow', 'yes']) await press('p1', action);

    expect(row('CARD#photo-p1')!.actedAt).toBeUndefined();
    expect(row('PHOTO#p1')!.seenAt).toBeUndefined();
    expect(busOf('card.retired')).toEqual([]);
    expect(aws.tags).toEqual([]);
  });

  it('a press for a picture that was never sent to this home does nothing at all', async () => {
    const tv = await press('never-sent', 'keep');

    expect(onTheMantel()).toEqual([]);
    expect(row('PHOTO#never-sent')).toBeUndefined();
    expect(aws.tags).toEqual([]);
    expect(tv.cards).toEqual([]);
  });

  it('the count and the name come from the rows, never from the press: a press cannot say there is room, or who sent it', async () => {
    holding(MAX_MANTEL);
    sent('p1');

    await television({ t: 'card_action', cardId: 'photo-p1', action: 'keep', at: 1_000, count: 0, fromName: 'Mallory', photoId: 'old1', householdId: 'hh-2' });

    expect(row('MANTEL#p1')).toBeUndefined();
    expect([...aws.rows.keys()].some((key) => key.startsWith('HH#hh-2'))).toBe(false);
  });
});

describe('when the bucket cannot be told', () => {
  it('"Keep it" keeps nothing it could not secure: the card comes back, unanswered and without a word, to be pressed again', async () => {
    sent('p1');
    aws.s3.fails = 'ServiceUnavailable';

    const tv = await press('p1', 'keep');

    expect(onTheMantel()).toEqual([]);
    expect(row('CARD#photo-p1')!.actedAt).toBeUndefined();
    expect(busOf('card.retired')).toEqual([]);
    expect(tv.cards.map((card) => [card.id, card.card.notice, card.respondsTo])).toEqual([['photo-p1', undefined, 'photo-p1']]);
    // Tried twice before giving up, and said so — without naming the picture.
    expect(aws.s3.asked).toBe(2);
    expect(said.some((line) => line.includes('photo_retag_failed'))).toBe(true);
    expect(said.join('\n')).not.toMatch(/p1/);

    aws.s3.fails = undefined;
    await press('p1', 'keep');
    expect(onTheMantel()).toEqual(['p1']);
  });

  it('"Thank you" is still her answer: the card is finished and seen, and the bucket lets go of the picture by itself in time', async () => {
    sent('p1');
    aws.s3.fails = 'ServiceUnavailable';

    await press('p1', 'thanks');

    expect(row('CARD#photo-p1')!.actedAt).toBeDefined();
    expect(row('PHOTO#p1')!.seenAt).toBeDefined();
  });
});

describe('a picture that is gone, and a bucket that refuses, are not the same answer', () => {
  /**
   * The distinction the whole "does not loop" rule rests on. S3 answers a
   * missing object with 404 only to a caller that may list the bucket — the
   * edge's roles are given that, on the pictures' bucket, for this alone
   * (infra/photos.tf, statement `TellAMissingPictureFromARefusal`). Without
   * it both cases answer 403 and could not be told apart; with it, a 403 is
   * a real refusal and must never be taken for "gone".
   */
  const refused = { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } };
  const gone = { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };

  it('403 on "Keep it": refused, not gone — the card comes back unanswered, nothing is finished, nothing is kept', async () => {
    sent('p1');
    aws.s3.fails = refused;

    const tv = await press('p1', 'keep');

    expect(row('CARD#photo-p1')!.actedAt).toBeUndefined();
    expect(busOf('card.retired')).toEqual([]);
    expect(onTheMantel()).toEqual([]);
    expect(row('MANTEL')).toBeUndefined();
    expect(tv.cards.map((card) => [card.id, card.card.notice, card.respondsTo])).toEqual([['photo-p1', undefined, 'photo-p1']]);
    // An ordinary failure: tried twice, and said.
    expect(aws.s3.asked).toBe(2);
    expect(said.some((line) => line.includes('photo_retag_failed'))).toBe(true);

    // The picture is still there: once the bucket answers, the same press keeps it.
    aws.s3.fails = undefined;
    await press('p1', 'keep');
    expect(onTheMantel()).toEqual(['p1']);
  });

  it('404 on "Keep it": gone — the card is finished, nothing is kept, and it does not come back', async () => {
    sent('p1');
    aws.s3.fails = gone;

    const tv = await press('p1', 'keep');

    expect(row('CARD#photo-p1')!.actedAt).toBeDefined();
    expect(busOf('card.retired').map((detail) => detail.cardId)).toEqual(['photo-p1']);
    expect(onTheMantel()).toEqual([]);
    expect(tv.cards).toEqual([]);
    expect(aws.s3.asked).toBe(1);
  });

  it('403 on "Thank you": still her answer — the card is finished and seen, and the failure is said, since the picture may still be there', async () => {
    sent('p1');
    aws.s3.fails = refused;

    await press('p1', 'thanks');

    expect(row('CARD#photo-p1')!.actedAt).toBeDefined();
    expect(row('PHOTO#p1')!.seenAt).toBeDefined();
    expect(aws.s3.asked).toBe(2);
    expect(said.some((line) => line.includes('photo_retag_failed'))).toBe(true);
  });
});

describe('when the picture’s bytes are gone — the bucket let go of it before she answered', () => {
  const missing = [
    ['by name', 'NoSuchKey'],
    ['by a plain 404', { name: 'NotFound', $metadata: { httpStatusCode: 404 } }],
    ['by a 404 under another name', { name: 'UnknownError', $metadata: { httpStatusCode: 404 } }],
  ] as const;

  for (const [how, error] of missing) {
    it(`"Keep it" does not loop (${how}): there is nothing to keep and never will be, so the card is finished like any answered card, and nothing is kept`, async () => {
      sent('p1');
      aws.s3.fails = error;

      const tv = await press('p1', 'keep');

      // Finished: claimed, seen, and taken off the home's other televisions.
      expect(row('CARD#photo-p1')!.actedAt).toBeDefined();
      expect(row('PHOTO#p1')!.seenAt).toBeDefined();
      expect(busOf('card.retired').map((detail) => detail.cardId)).toEqual(['photo-p1']);
      // Nothing kept, nothing counted, the home screen unchanged.
      expect(onTheMantel()).toEqual([]);
      expect(row('MANTEL')).toBeUndefined();
      expect(tv.controls).toEqual([]);
      expect(busOf('home.changed')).toEqual([]);
      // And NOT sent back as a keeping that failed.
      expect(tv.cards).toEqual([]);
      // A missing object is not an error worth a second try, or a line in the log.
      expect(aws.s3.asked).toBe(1);
      expect(said.filter((line) => /failed|error/i.test(line))).toEqual([]);
    });
  }

  it('a second "Keep it" on it — from a television that still held the card — changes nothing and asks the bucket nothing', async () => {
    sent('p1');
    aws.s3.fails = 'NoSuchKey';
    await press('p1', 'keep');
    aws.s3.asked = 0;

    const tv = await press('p1', 'keep', 'tv-2');

    expect(aws.s3.asked).toBe(0);
    expect(tv.cards).toEqual([]);
    expect(onTheMantel()).toEqual([]);
  });

  it('"Thank you" simply finishes: seen, the card put away, and the missing object neither retried nor called an error', async () => {
    sent('p1');
    aws.s3.fails = 'NoSuchKey';

    const tv = await press('p1', 'thanks');

    expect(row('CARD#photo-p1')!.actedAt).toBeDefined();
    expect(row('PHOTO#p1')!.seenAt).toBeDefined();
    expect(busOf('card.retired').map((detail) => detail.cardId)).toEqual(['photo-p1']);
    expect(tv.cards).toEqual([]);
    expect(aws.s3.asked).toBe(1);
    expect(said.filter((line) => /failed|error/i.test(line))).toEqual([]);
  });

  it('looks the same from outside as any picture she answered: seen, and nothing more', async () => {
    sent('p1');
    sent('p2');
    aws.s3.fails = 'NoSuchKey';
    await press('p1', 'keep');
    aws.s3.fails = undefined;
    await press('p2', 'thanks');

    const shape = (sk: string) => Object.keys(row(sk)!).sort();
    expect(shape('PHOTO#p1')).toEqual(shape('PHOTO#p2'));
    expect(shape('CARD#photo-p1')).toEqual(shape('CARD#photo-p2'));
  });

  it('taking down a thing whose bytes are gone still takes it down', async () => {
    holding(2);
    aws.s3.fails = 'NoSuchKey';

    const tv = await television({ t: 'mantel_take_down', photoId: 'old0', at: 5 });

    expect(onTheMantel()).toEqual(['old1']);
    expect(row('MANTEL')!.count).toEqual({ N: '1' });
    expect(tv.controls.find((control) => control.t === 'home')).toEqual({ t: 'home', home: { mantel: 1 }, whole: true });
    expect(aws.s3.asked).toBe(1);
  });
});

describe('{ t: "mantel" } — she opens her mantelpiece', () => {
  beforeEach(() => {
    put({ pk: { S: HH }, sk: { S: 'MANTEL#late' }, photoId: { S: 'late' }, fromName: { S: 'Tom' }, keptAt: { N: '300' } });
    put({ pk: { S: HH }, sk: { S: 'MANTEL#early' }, photoId: { S: 'early' }, fromName: { S: 'Sarah' }, keptAt: { N: '100' } });
    put({ pk: { S: HH }, sk: { S: 'MANTEL#down' }, photoId: { S: 'down' }, fromName: { S: 'Sarah' }, keptAt: { N: '200' }, downAt: { N: '250' }, ttl: { N: '9' } });
    put({ pk: { S: HH }, sk: { S: 'MANTEL' }, count: { N: '2' } });
  });

  it('answers the television that asked, and only it, with what she has kept — oldest first, each with an address minted now, good for an hour', async () => {
    const tv = await television({ t: 'mantel', at: 1 });

    expect(tv.cards).toEqual([]);
    expect(tv.controls).toHaveLength(1);
    const [control] = tv.controls as [{ t: string; items: { photoId: string; fromName: string; keptAt: number; url: string }[] }];
    expect(control.t).toBe('mantel');
    expect(control.items.map(({ photoId, fromName, keptAt }) => ({ photoId, fromName, keptAt }))).toEqual([
      { photoId: 'early', fromName: 'Sarah', keptAt: 100 },
      { photoId: 'late', fromName: 'Tom', keptAt: 300 },
    ]);
    for (const item of control.items) {
      const url = addressOf(item.url);
      expect(url.host).toBe('wick-photos-test.s3.us-east-1.amazonaws.com');
      expect(url.pathname).toBe(`/photos/hh-1/${item.photoId}.jpg`);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
      expect(url.searchParams.get('X-Amz-Security-Token')).toBe('test-session-token');
    }
    // It is what the television's own reader expects.
    expect(readMantelItems(control.items)).toEqual(control.items);
  });

  it('goes nowhere else: nothing on the bus, nothing written, nothing on the timeline', async () => {
    const before = JSON.stringify([...aws.rows.entries()]);

    await television({ t: 'mantel', at: 1 });

    expect(aws.events).toEqual([]);
    expect(JSON.stringify([...aws.rows.entries()])).toBe(before);
    expect(aws.sent.filter((call) => call.name !== 'Get' && call.name !== 'Query')).toEqual([]);
    expect(aws.tags).toEqual([]);
  });

  it('answers an empty mantelpiece with an empty one', async () => {
    aws.rows.clear();
    put({ pk: { S: HH }, sk: { S: 'DEV#tv-1' } });

    const tv = await television({ t: 'mantel', at: 1 });

    expect(tv.controls).toEqual([{ t: 'mantel', items: [] }]);
  });

  it('answers a television that has been revoked with nothing', async () => {
    put({ pk: { S: HH }, sk: { S: 'DEV#tv-1' }, denylisted: { BOOL: true } });

    const tv = await television({ t: 'mantel', at: 1 });

    expect(tv.result).toEqual({ statusCode: 403, body: 'revoked' });
    expect(tv.controls).toEqual([]);
  });
});

describe('{ t: "mantel_take_down" } — she takes one thing down', () => {
  beforeEach(() => holding(3));

  it('takes it off her mantelpiece, gives its place back, and lets the bucket let go of it', async () => {
    await television({ t: 'mantel_take_down', photoId: 'old1', at: 5 });

    expect(onTheMantel()).toEqual(['old0', 'old2']);
    expect(row('MANTEL')!.count).toEqual({ N: '2' });
    expect(aws.tags).toEqual([{ key: 'photos/hh-1/old1.jpg', state: 'state=gone' }]);
    // The row is not deleted by the edge: it is marked, and given a day.
    const down = row('MANTEL#old1')!;
    expect(down.downAt).toBeDefined();
    expect(Number(down.ttl!.N)).toBeGreaterThan(Date.now() / 1000);
    expect(Number(down.ttl!.N)).toBeLessThanOrEqual(Date.now() / 1000 + 24 * 60 * 60 + 1);
  });

  it('answers the television that asked with the mantelpiece as it now stands, and tells every home screen the count', async () => {
    const tv = await television({ t: 'mantel_take_down', photoId: 'old1', at: 5 });

    const mantel = tv.controls.find((control) => control.t === 'mantel') as { items: { photoId: string }[] };
    expect(mantel.items.map((item) => item.photoId)).toEqual(['old0', 'old2']);
    expect(tv.controls.find((control) => control.t === 'home')).toEqual({ t: 'home', home: { mantel: 2 }, whole: true });
    expect(readHomeState(busOf('home.changed')[0].home)).toEqual({ mantel: 2 });
    // What is on the bus is the count. The mantelpiece itself is not.
    expect(JSON.stringify(aws.events)).not.toMatch(/https:|X-Amz|items|old0/);
  });

  it('takes the last thing down to an empty mantelpiece: the home screen is told of none at all', async () => {
    aws.rows.delete(`${HH}|MANTEL#old1`);
    aws.rows.delete(`${HH}|MANTEL#old2`);
    put({ pk: { S: HH }, sk: { S: 'MANTEL' }, count: { N: '1' } });

    const tv = await television({ t: 'mantel_take_down', photoId: 'old0', at: 5 });

    expect(tv.controls).toEqual([{ t: 'mantel', items: [] }, { t: 'home', home: {}, whole: true }]);
    expect(row('MANTEL')!.count).toEqual({ N: '0' });
  });

  it('changes nothing for a picture that is not on her mantelpiece — and tells the bucket nothing: a picture still to be answered is not let go of', async () => {
    sent('waiting');
    const before = JSON.stringify([...aws.rows.entries()]);

    for (const photoId of ['waiting', 'never', 'old9']) await television({ t: 'mantel_take_down', photoId, at: 5 });

    expect(JSON.stringify([...aws.rows.entries()])).toBe(before);
    expect(aws.tags).toEqual([]);
    expect(busOf('home.changed')).toEqual([]);
  });

  it('changes nothing the second time', async () => {
    await television({ t: 'mantel_take_down', photoId: 'old1', at: 5 });
    aws.tags.length = 0;

    await television({ t: 'mantel_take_down', photoId: 'old1', at: 6 });

    expect(row('MANTEL')!.count).toEqual({ N: '2' });
    expect(aws.tags).toEqual([]);
  });

  it('refuses an id that is not a picture’s, before anything is read for it', async () => {
    for (const photoId of ['../../x', 'a/b', '', undefined, 7]) {
      const tv = await television({ t: 'mantel_take_down', photoId, at: 5 });
      expect(tv.result).toEqual({ statusCode: 400, body: 'bad_device_event' });
    }
    expect(aws.tags).toEqual([]);
    expect(onTheMantel()).toHaveLength(3);
  });
});

describe('a picture’s card sent again', () => {
  it('reconcile replays it with an address minted for this television, and the stored card still has none', async () => {
    sent('p1');
    const before = row('CARD#photo-p1')!.data!.S;

    const tv = await television({ t: 'reconcile', at: 1 });

    expect(tv.cards).toHaveLength(1);
    const { photoUrl, ...rest } = tv.cards[0]!.card;
    expect(rest).toEqual(photoCard('p1').card);
    expect(addressOf(photoUrl).pathname).toBe('/photos/hh-1/p1.jpg');
    expect(row('CARD#photo-p1')!.data!.S).toBe(before);
    expect(JSON.stringify([...aws.rows.values()])).not.toMatch(/X-Amz|photoUrl/);
    expect(JSON.stringify(aws.events)).not.toMatch(/X-Amz|photoUrl/);
  });

  it('and every other card of an English household is replayed byte for byte as it is stored', async () => {
    const note = { id: 'note-1', urgency: 'DEFERRED', card: { type: 'MESSAGE', id: 'note-1', householdId: 'hh-1', correlationId: 'c', createdAt: 1, fromName: 'Sarah', transcript: 'Ring me tonight, Mum.', suggestedReplies: ['I will'], actions: [] }, queuedAt: 2, shownCount: 0 };
    put({ pk: { S: HH }, sk: { S: 'CARD#note-1' }, data: { S: JSON.stringify(note) } });

    const tv = await television({ t: 'reconcile', at: 1 });

    expect(JSON.stringify(tv.cards)).toBe(JSON.stringify([note]));
    expect(tv.controls).toEqual([{ t: 'home', home: {}, whole: true }]);
  });

  it('the home screen learns the count when the television connects', async () => {
    holding(2);

    const tv = await television({ t: 'reconcile', at: 1 });

    expect(tv.controls).toEqual([{ t: 'home', home: { mantel: 2 }, whole: true }]);
  });
});
