/**
 * The television speaks her language — the edge's handler, whole
 * (device-event.mjs): what a television is sent when it asks for what it is
 * owed, and what her press on the question's card does.
 *
 * The table and the bus are in memory. The phrasebook is a small one of
 * this file's own, in place of the generated copy, so these tests hold
 * whatever its sentences come to be.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Value = { S?: string; N?: string; BOOL?: boolean; SS?: string[] };
type Row = Record<string, Value>;

const aws = vi.hoisted(() => {
  process.env.TABLE_NAME = 'wick';
  process.env.EVENT_BUS_NAME = 'wick-bus';
  return {
    rows: new Map<string, Record<string, { S?: string; N?: string; BOOL?: boolean; SS?: string[] }>>(),
    sent: [] as { name: string; input: Record<string, unknown> }[],
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
  const refused = () => Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });

  /** The few shapes of update the handler makes on the rows these tests look at. */
  function update(input: { Key: Row; UpdateExpression: string; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Row }) {
    const names = input.ExpressionAttributeNames ?? {};
    const values = input.ExpressionAttributeValues ?? {};
    const existing = aws.rows.get(keyOf(input.Key));
    const attr = (name: string) => names[name] ?? name;

    const condition = input.ConditionExpression;
    if (condition === 'attribute_exists(pk)') {
      if (!existing) throw refused();
    } else if (condition !== undefined) {
      const equals = /^(#?\w+) = (:\w+)$/.exec(condition);
      // Anything else (a television's "signalled lately" claim) is not these tests' business: refused, which the handler takes quietly.
      if (!equals || existing?.[attr(equals[1]!)]?.S !== values[equals[2]!]?.S) throw refused();
    }

    const row: Row = { ...(existing ?? input.Key) };
    const [, set = '', remove = ''] = /^(?:SET (.*?))?(?: ?REMOVE (.*))?$/.exec(input.UpdateExpression) ?? [];
    // A comma inside if_not_exists(…) does not end an assignment.
    for (const assignment of set.split(/,(?![^(]*\))/).map((part) => part.trim()).filter(Boolean)) {
      const [name, expression] = assignment.split(/=(.*)/).map((part) => part.trim()) as [string, string];
      const once = /^if_not_exists\((#?\w+), (:\w+)\)$/.exec(expression);
      if (once) row[attr(name)] = row[attr(once[1]!)] ?? values[once[2]!]!;
      else row[attr(name)] = values[expression]!;
    }
    for (const name of remove.split(',').map((part) => part.trim()).filter(Boolean)) delete row[attr(name)];
    aws.rows.set(keyOf(input.Key), row);
  }

  class DynamoDBClient {
    async send(cmd: { name: string; input: Record<string, unknown> }) {
      aws.sent.push({ name: cmd.name, input: cmd.input });
      if (cmd.name === 'Get') return { Item: aws.rows.get(keyOf(cmd.input.Key as Row)) };
      if (cmd.name === 'Put') {
        aws.rows.set(keyOf(cmd.input.Item as Row), cmd.input.Item as Row);
        return {};
      }
      if (cmd.name === 'Update') {
        update(cmd.input as Parameters<typeof update>[0]);
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
    // The mantelpiece's; nothing in these tests makes one.
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

/** Wick's sentences are marked with the language; free text is replaced only by what is handed in. */
vi.mock('../phrasebook.generated.mjs', () => ({
  cardIn: (language: string, card: Record<string, unknown>, free: Record<string, string> = {}) => ({
    ...card,
    ...(typeof card.headline === 'string' ? { headline: `[${language}] ${card.headline}` } : {}),
    ...(typeof card.line === 'string' ? { line: `[${language}] ${card.line}` } : {}),
    ...free,
  }),
  patchIn: (_language: string, patch: unknown) => patch,
  homeIn: (language: string, home: { lookedIn?: { line: string } }) => ({ ...home, ...(home.lookedIn ? { lookedIn: { ...home.lookedIn, line: `[${language}] ${home.lookedIn.line}` } } : {}) }),
}));

// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
const { handleDeviceEvent } = await import('../device-event.mjs');

const HH = 'HH#hh-1';
const put = (row: Row) => aws.rows.set(`${row.pk!.S}|${row.sk!.S}`, row);
const metaRow = () => aws.rows.get(`${HH}|META`)!;

const note = { type: 'MESSAGE', id: 'note-1', householdId: 'hh-1', correlationId: 'c', createdAt: 1, fromName: 'Sarah', transcript: 'Ring me tonight, Mum.', suggestedReplies: ['I will', 'Not tonight', 'Thank you'], actions: [] };
const queuedNote = { id: 'note-1', urgency: 'DEFERRED', card: note, queuedAt: 2, shownCount: 0 };
const circle = { type: 'CIRCLE', id: 'circle-u2', householdId: 'hh-1', correlationId: 'c2', createdAt: 1, personName: 'Tom', role: 'family', headline: 'Tom would like to join.', detail: 'd', actions: [] };
const queuedCircle = { id: 'circle-u2', urgency: 'DEFERRED', card: circle, queuedAt: 3, shownCount: 0 };

function home(options: { language?: string; asked?: string; declined?: string } = {}) {
  aws.rows.clear();
  aws.sent.length = 0;
  aws.events.length = 0;
  put({ pk: { S: HH }, sk: { S: 'DEV#tv-1' } });
  put({
    pk: { S: HH },
    sk: { S: 'META' },
    ...(options.language ? { language: { S: options.language } } : {}),
    ...(options.asked ? { languageAsked: { S: options.asked }, languageAskedBy: { S: 'Sarah' }, languageAskedAt: { N: '100' } } : {}),
    ...(options.declined ? { languageDeclined: { S: options.declined }, languageDeclinedAt: { N: '50' } } : {}),
  });
  put({ pk: { S: HH }, sk: { S: 'MEM#u1' }, name: { S: 'Sarah Hughes' }, status: { S: 'allowed' } });
}

async function television(deviceEvent: Record<string, unknown>) {
  const cards: unknown[] = [];
  const controls: unknown[] = [];
  const result = await handleDeviceEvent({
    householdId: 'hh-1',
    deviceId: 'tv-1',
    deviceEvent,
    sendCard: async (card: unknown) => { cards.push(card); return true; },
    sendControl: async (control: unknown) => { controls.push(control); return true; },
  });
  return { result, cards, controls, bytes: JSON.stringify(cards) };
}

const homeChanged = () => aws.events.filter((entry) => entry.DetailType === 'home.changed').map((entry) => JSON.parse(entry.Detail));

beforeEach(() => home());

describe('reconcile — the cards a television is owed, in the household’s language', () => {
  const stored = (extra: Row = {}) => put({ pk: { S: HH }, sk: { S: 'CARD#note-1' }, data: { S: JSON.stringify(queuedNote) }, ...extra });

  it('hands an English household its stored cards exactly as they are stored, and its home as it always was', async () => {
    stored({ tr_es: { S: '{"transcript":"Llámame esta noche, mamá."}' } });
    put({ pk: { S: HH }, sk: { S: 'CARD#circle-u2' }, data: { S: JSON.stringify(queuedCircle) } });

    const tv = await television({ t: 'reconcile', at: 1 });

    expect(tv.result).toEqual({ statusCode: 200, body: '' });
    expect(tv.bytes).toBe(JSON.stringify([queuedCircle, queuedNote]));
    expect(tv.controls).toEqual([{ t: 'home', home: { light: 'on' }, whole: true }]);
  });

  it('hands a Spanish household each stored card through the phrasebook, with the free text kept beside it — and the row stays English', async () => {
    home({ language: 'es' });
    stored({ tr_es: { S: '{"transcript":"Llámame esta noche, mamá."}' } });
    put({ pk: { S: HH }, sk: { S: 'CARD#circle-u2' }, data: { S: JSON.stringify(queuedCircle) } });

    const tv = await television({ t: 'reconcile', at: 1 });

    expect(tv.cards).toEqual([
      { ...queuedCircle, card: { ...circle, headline: '[es] Tom would like to join.' } },
      { ...queuedNote, card: { ...note, transcript: 'Llámame esta noche, mamá.' } },
    ]);
    expect(tv.controls).toEqual([{ t: 'home', home: { light: 'on', language: 'es' }, whole: true }]);
    expect(JSON.parse(aws.rows.get(`${HH}|CARD#note-1`)!.data!.S!)).toEqual(queuedNote);
    // Nothing was written to any card: the edge only reads what was translated.
    expect(aws.sent.filter((c) => c.name !== 'Get' && c.name !== 'Query').map((c) => (c.input.Key as Row | undefined)?.sk?.S ?? (c.input.Item as Row).sk!.S)).not.toContainEqual(expect.stringMatching(/^CARD#/));
  });

  it('replays every unanswered card whether or not the television says it holds it — so a television that asks again after the language changes has its cards replaced', async () => {
    home({ language: 'es' });
    stored();
    put({ pk: { S: HH }, sk: { S: 'CARD#circle-u2' }, data: { S: JSON.stringify(queuedCircle) }, actedAt: { N: '50' } });

    const tv = await television({ t: 'reconcile', at: 1, holding: ['note-1', 'circle-u2'], sinceCardId: 'note-1' });

    // Held and unanswered: sent again, in her language. Held and answered: taken back, not sent.
    expect(tv.cards).toEqual([{ ...queuedNote, card: note }]);
    expect(tv.controls[0]).toEqual({ t: 'revoke', cardId: 'circle-u2' });
  });

  it('reads the language as it is this instant, for the cards and for the home alike: this is the asking her television makes the moment its language changes', async () => {
    home({ language: 'es' });
    stored();

    await television({ t: 'reconcile', at: 1 });

    // The cards' language: the household's own row, read consistently.
    const languageRead = aws.sent.filter((c) => c.name === 'Get' && (c.input.Key as Row).sk!.S === 'META');
    expect(languageRead).toHaveLength(1);
    expect(languageRead[0]!.input.ConsistentRead).toBe(true);
    // The home's language: the rows the home message is built from, read consistently too —
    // told `whole`, a stale one would tell her television the language she has just left.
    const homeRead = aws.sent.filter((c) => c.name === 'Query' && (c.input.ExpressionAttributeValues as Row)[':to']?.S === 'META');
    expect(homeRead).toHaveLength(1);
    expect(homeRead[0]!.input.ConsistentRead).toBe(true);
  });

  it('reads the language once for the whole replay, and not at all when there is nothing to replay', async () => {
    home({ language: 'es' });
    const languageReads = () => aws.sent.filter((c) => c.name === 'Get' && (c.input.Key as Row).sk!.S === 'META').length;

    await television({ t: 'reconcile', at: 1 });
    expect(languageReads()).toBe(0);

    stored();
    put({ pk: { S: HH }, sk: { S: 'CARD#circle-u2' }, data: { S: JSON.stringify(queuedCircle) } });
    aws.sent.length = 0;
    await television({ t: 'reconcile', at: 1 });
    expect(languageReads()).toBe(1);
  });
});

describe('a card built on the spot', () => {
  it('is the Light card in her language, from the rows already read for it — no read of its own', async () => {
    home({ language: 'es' });

    const tv = await television({ t: 'light', at: 1 });

    expect(tv.cards).toHaveLength(1);
    expect((tv.cards[0] as { card: { headline: string } }).card.headline).toBe('[es] Your light is on.');
    expect(aws.sent.filter((c) => c.name === 'Get' && (c.input.Key as Row).sk!.S === 'META')).toEqual([]);
  });

  it('is the Light card as it always was for an English household', async () => {
    const tv = await television({ t: 'light', at: 1 });

    expect((tv.cards[0] as { card: { headline: string } }).card.headline).toBe('Your light is on.');
  });
});

describe('her answer to the language question', () => {
  const press = (cardId: string, action: string) => television({ t: 'card_action', cardId, action, at: 1_000 });

  it('yes: the household speaks Spanish from that press, and every television is told — this one at once, the others through the bus', async () => {
    home({ asked: 'es' });

    const tv = await press('language-es', 'yes');

    expect(metaRow()).toEqual({ pk: { S: HH }, sk: { S: 'META' }, language: { S: 'es' } });
    expect(tv.controls).toEqual([{ t: 'home', home: { light: 'on', language: 'es' }, whole: true }]);
    expect(homeChanged()).toEqual([expect.objectContaining({ householdId: 'hh-1', deviceId: 'tv-1', home: { light: 'on', language: 'es' } })]);
    // What is told was read after the write, and as it stands.
    const homeRead = aws.sent.filter((c) => c.name === 'Query').at(-1)!;
    expect(homeRead.input.ConsistentRead).toBe(true);
    expect(aws.sent.findIndex((c) => c === homeRead)).toBeGreaterThan(aws.sent.findIndex((c) => c.name === 'Update' && (c.input.Key as Row).sk!.S === 'META'));
  });

  it('no: the language stays as it was, the question is closed, and her no is kept — which language, and when by this server’s clock', async () => {
    home({ asked: 'es' });
    const before = Date.now();

    const tv = await press('language-es', 'no');

    const { languageDeclinedAt, ...rest } = metaRow();
    expect(rest).toEqual({ pk: { S: HH }, sk: { S: 'META' }, languageDeclined: { S: 'es' } });
    // Not the television's `at` (1000): when she answered is not the television's to say.
    expect(Number(languageDeclinedAt!.N)).toBeGreaterThanOrEqual(before);
    expect(Number(languageDeclinedAt!.N)).toBeLessThanOrEqual(Date.now());
    expect(tv.controls).toEqual([{ t: 'home', home: { light: 'on' }, whole: true }]);
  });

  it('yes, after an earlier no: the no is taken off the record with the question', async () => {
    home({ asked: 'es', declined: 'es' });

    await press('language-es', 'yes');

    expect(metaRow()).toEqual({ pk: { S: HH }, sk: { S: 'META' }, language: { S: 'es' } });
  });

  it('yes to English: the language is taken off the row, and the home is told without one', async () => {
    home({ language: 'es', asked: 'en' });

    const tv = await press('language-en', 'yes');

    expect(metaRow()).toEqual({ pk: { S: HH }, sk: { S: 'META' } });
    expect(tv.controls).toEqual([{ t: 'home', home: { light: 'on' }, whole: true }]);
    expect(homeChanged()[0].home).toEqual({ light: 'on' });
  });

  it('no to English: she goes on in Spanish', async () => {
    home({ language: 'es', asked: 'en' });

    const tv = await press('language-en', 'no');

    expect(metaRow()).toMatchObject({ language: { S: 'es' }, languageDeclined: { S: 'en' } });
    expect(metaRow().languageAsked).toBeUndefined();
    expect(tv.controls).toEqual([{ t: 'home', home: { light: 'on', language: 'es' }, whole: true }]);
  });

  it('a stale press — no question open — changes nothing: no language, and no answer put on record or taken off it', async () => {
    home();

    await press('language-es', 'yes');
    await press('language-es', 'no');

    expect(metaRow()).toEqual({ pk: { S: HH }, sk: { S: 'META' } });
    expect(homeChanged()[0].home).toEqual({ light: 'on' });

    home({ declined: 'es' });
    const said = { ...metaRow() };
    await press('language-es', 'yes');
    await press('language-es', 'no');
    expect(metaRow()).toEqual(said);
  });

  it('a press for a language other than the one asked about changes nothing, and leaves the question open', async () => {
    home({ language: 'es', asked: 'en' });
    const before = { ...metaRow() };

    await press('language-es', 'yes');
    await press('language-es', 'no');

    expect(metaRow()).toEqual(before);
  });

  it('a press for a language Wick does not speak is not an answer at all', async () => {
    home({ asked: 'es' });
    const before = { ...metaRow() };

    await press('language-fr', 'yes');

    expect(metaRow()).toEqual(before);
    expect(aws.sent.filter((c) => c.name === 'Update' && (c.input.Key as Row).sk!.S === 'META')).toEqual([]);
    expect(homeChanged()).toEqual([]);
  });

  describe('says on the bus that the language changed — and only when her press changed it — so the cards she has not answered can be put into it', () => {
    const changedTo = () => homeChanged().map((detail) => detail.languageChangedTo);

    it('yes: the event that tells the home’s other televisions also says which language it now is, with an id of its own to follow it by', async () => {
      home({ asked: 'es' });

      await press('language-es', 'yes');

      const [detail] = homeChanged();
      expect(detail.languageChangedTo).toBe('es');
      expect(detail.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      // What it carries: the household, the television, the home screen, the time, and those two. No card, no words.
      expect(Object.keys(detail).sort()).toEqual(['at', 'correlationId', 'deviceId', 'home', 'householdId', 'languageChangedTo']);
    });

    it('yes to English: says so too — there is nothing to translate, but it is a change', async () => {
      home({ language: 'es', asked: 'en' });

      await press('language-en', 'yes');

      expect(changedTo()).toEqual(['en']);
    });

    it('no, a stale press, and a press for another language: the home is re-told, and nothing says the language changed', async () => {
      home({ asked: 'es' });
      await press('language-es', 'no');
      home();
      await press('language-es', 'yes');
      home({ language: 'es', asked: 'en' });
      await press('language-es', 'yes');

      for (const detail of homeChanged()) {
        expect(Object.keys(detail).sort()).toEqual(['at', 'deviceId', 'home', 'householdId']);
      }
      expect(homeChanged().length).toBeGreaterThan(0);
    });

    it('a second yes to a question already answered changes nothing, and says nothing changed', async () => {
      home({ asked: 'es' });
      await press('language-es', 'yes');
      aws.events.length = 0;

      await press('language-es', 'yes');

      expect(changedTo()).toEqual([undefined]);
    });
  });

  it('finishes the question’s card like any other answered card, so it is not asked again and comes off the home’s other televisions', async () => {
    home({ asked: 'es' });
    put({ pk: { S: HH }, sk: { S: 'CARD#language-es' }, data: { S: JSON.stringify({ id: 'language-es', urgency: 'DEFERRED', card: { type: 'LANGUAGE', id: 'language-es' }, queuedAt: 1, shownCount: 0 }) } });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    await press('language-es', 'yes');
    vi.useRealTimers();

    expect(aws.rows.get(`${HH}|CARD#language-es`)!.actedAt).toEqual({ N: '1000' });
    expect(aws.events.filter((entry) => entry.DetailType === 'card.retired').map((entry) => JSON.parse(entry.Detail).cardId)).toEqual(['language-es']);
  });
});

describe('"What your family sees" from her Light card, at any time', () => {
  it('opens the first page of what is shared, not over the Light card, which is not kept', async () => {
    const tv = await television({ t: 'card_action', cardId: 'light', action: 'sharing', at: 1_000 });

    const sharing = tv.cards.find((c) => (c as { id: string }).id === 'sharing') as { respondsTo?: string; card: { type: string; page: number } } | undefined;
    expect(sharing).toBeDefined();
    expect(sharing!.card).toMatchObject({ type: 'SHARING', page: 0 });
    expect(sharing!.respondsTo).toBeUndefined();
  });
});
