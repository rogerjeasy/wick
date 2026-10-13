/**
 * Read to me — the edge's handler, whole (device-event.mjs): what a
 * television is answered when she presses Play on a card, and what of it
 * anything else can see.
 *
 * The table, the bus and the bucket are in memory; the voice is handed in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPEECH_URL_TTL_SEC, SPEECH_VOICES } from '@wick/contracts';

type Value = { S?: string; N?: string; BOOL?: boolean };
type Row = Record<string, Value>;
type Names = Record<string, string>;

const aws = vi.hoisted(() => {
  Object.assign(process.env, {
    TABLE_NAME: 'wick',
    EVENT_BUS_NAME: 'wick-bus',
    MEDIA_BUCKET: 'wick-media-test',
    // Made up, and shaped like nothing a real key is.
    AWS_ACCESS_KEY_ID: 'test-access-key-id',
    AWS_SECRET_ACCESS_KEY: 'test/secret+value',
    AWS_SESSION_TOKEN: 'test-session-token',
    AWS_REGION: 'us-east-1',
  });
  return {
    rows: new Map<string, Record<string, { S?: string; N?: string; BOOL?: boolean }>>(),
    events: [] as unknown[],
    /** The bucket: what is in it, and everything it was asked. */
    objects: new Map<string, { bytes: number[]; contentType: string | undefined }>(),
    s3: [] as { name: string; key: string; bucket: string }[],
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

  function holds(condition: string | undefined, row: Row | undefined, names: Names, values: Row): boolean {
    if (condition === undefined) return true;
    if (condition.includes('activeSignalAt')) return false;
    const attr = (name: string) => row?.[names[name] ?? name];
    const atom = (text: string): boolean => {
      const exists = /^attribute_(not_)?exists\((#?\w+)\)$/.exec(text);
      if (exists) return exists[1] ? attr(exists[2]!) === undefined : attr(exists[2]!) !== undefined;
      const less = /^(#?\w+) < (:\w+)$/.exec(text);
      if (!less) throw new Error(`a condition this table does not know: ${text}`);
      const have = attr(less[1]!);
      return have !== undefined && Number(have.N) < Number(values[less[2]!]!.N);
    };
    return condition.split(' OR ').some((all) => all.split(' AND ').every((one) => atom(one.trim())));
  }

  function applied(row: Row, expression: string, names: Names, values: Row): Row {
    const next: Row = { ...row };
    const attr = (name: string) => names[name] ?? name;
    for (const [, verb, body] of expression.matchAll(/(SET|ADD) (.*?)(?= (?:SET|ADD) |$)/g)) {
      for (const part of body!.split(',').map((text) => text.trim()).filter(Boolean)) {
        if (verb === 'ADD') {
          const [name, value] = part.split(/\s+/) as [string, string];
          next[attr(name)] = { N: String(Number(next[attr(name)]?.N ?? 0) + Number(values[value]!.N)) };
        } else {
          const [name, right] = part.split('=').map((text) => text.trim()) as [string, string];
          next[attr(name)] = values[right]!;
        }
      }
    }
    return next;
  }

  class DynamoDBClient {
    async send(cmd: { name: string; input: Record<string, unknown> }) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const input = cmd.input as { Key?: Row; Item?: Row; UpdateExpression?: string; ConditionExpression?: string; ExpressionAttributeNames?: Names; ExpressionAttributeValues?: Row };
      if (cmd.name === 'Get') return { Item: aws.rows.get(keyOf(input.Key!)) };
      if (cmd.name === 'Put') {
        aws.rows.set(keyOf(input.Item!), input.Item!);
        return {};
      }
      if (cmd.name === 'Update') {
        const key = keyOf(input.Key!);
        if (!holds(input.ConditionExpression, aws.rows.get(key), input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {})) throw refused();
        aws.rows.set(key, applied(aws.rows.get(key) ?? input.Key!, input.UpdateExpression!, input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {}));
        return {};
      }
      if (cmd.name !== 'Query') throw new Error(`this table was not expecting a ${cmd.name}`);
      const values = input.ExpressionAttributeValues!;
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
    async send(cmd: { input: { Entries: unknown[] } }) {
      aws.events.push(...cmd.input.Entries);
      return {};
    }
  },
  PutEventsCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-s3', () => {
  const command = (name: string) =>
    class {
      readonly name = name;
      constructor(readonly input: { Bucket: string; Key: string; Body?: Uint8Array; ContentType?: string }) {}
    };
  return {
    S3Client: class {
      async send(cmd: { name: string; input: { Bucket: string; Key: string; Body?: Uint8Array; ContentType?: string } }) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        aws.s3.push({ name: cmd.name, key: cmd.input.Key, bucket: cmd.input.Bucket });
        if (cmd.name === 'Head') {
          // As S3 answers a role that may not list the bucket: not "not found", but "forbidden".
          if (!aws.objects.has(cmd.input.Key)) throw Object.assign(new Error('Forbidden'), { name: '403', $metadata: { httpStatusCode: 403 } });
          return {};
        }
        if (cmd.name === 'Put') {
          aws.objects.set(cmd.input.Key, { bytes: [...cmd.input.Body!], contentType: cmd.input.ContentType });
          return {};
        }
        throw new Error(`this bucket was not expecting a ${cmd.name}`);
      }
    },
    HeadObjectCommand: command('Head'),
    PutObjectCommand: command('Put'),
    PutObjectTaggingCommand: command('Tag'),
  };
});

/** Wick's sentences are marked with the language; free text is replaced only by what is handed in. */
vi.mock('../phrasebook.generated.mjs', () => ({
  cardIn: (language: string, card: { actions?: { label: string }[]; suggestedReplies?: string[] } & Record<string, unknown>, free: Record<string, string> = {}) => ({
    ...card,
    ...(typeof card.headline === 'string' ? { headline: `[${language}] ${card.headline}` } : {}),
    ...(Array.isArray(card.suggestedReplies) ? { suggestedReplies: card.suggestedReplies.map((reply) => `[${language}] ${reply}`) } : {}),
    ...free,
  }),
  patchIn: (_language: string, patch: unknown) => patch,
  homeIn: (_language: string, home: unknown) => home,
}));

// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
const { handleDeviceEvent } = await import('../device-event.mjs');
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
const { readingOf } = await import('../speech.mjs');

const HH = 'HH#hh-1';
const put = (item: Row) => aws.rows.set(`${item.pk!.S}|${item.sk!.S}`, item);
const AUDIO = [0xff, 0xf3, 0x44, 0xc4];

const note = { type: 'MESSAGE', id: 'note-1', householdId: 'hh-1', correlationId: 'c', createdAt: 1, fromName: 'Sarah', transcript: 'Ring me tonight, Mum & Dad <3.', suggestedReplies: ['I will', 'Not tonight'], actions: [] };
const queuedNote = { id: 'note-1', urgency: 'DEFERRED', card: note, queuedAt: 2, shownCount: 0 };
const NOTE_SSML = '<speak>Sarah.<break time="600ms"/>Ring me tonight, Mum &amp; Dad &lt;3.<break time="600ms"/>I will.<break time="600ms"/>Not tonight.</speak>';

function home(options: { language?: string } = {}) {
  aws.rows.clear();
  put({ pk: { S: HH }, sk: { S: 'DEV#tv-1' } });
  put({ pk: { S: HH }, sk: { S: 'META' }, ...(options.language ? { language: { S: options.language } } : {}) });
  put({ pk: { S: HH }, sk: { S: 'MEM#u1' }, name: { S: 'Sarah Hughes' }, status: { S: 'allowed' } });
}
const storeNote = (extra: Row = {}) => put({ pk: { S: HH }, sk: { S: 'CARD#note-1' }, data: { S: JSON.stringify(queuedNote) }, ...extra });

function voice() {
  return vi.fn(async (_input: { Text: string; VoiceId: string; LanguageCode: string; Engine: string; OutputFormat: string; TextType: string }, _signal: AbortSignal) => new Uint8Array(AUDIO));
}

async function television(deviceEvent: Record<string, unknown>, options: { synthesize?: ReturnType<typeof voice> | null } = {}) {
  const cards: unknown[] = [];
  const controls: Record<string, unknown>[] = [];
  const synthesize = options.synthesize === undefined ? voice() : options.synthesize;
  const result = await handleDeviceEvent({
    householdId: 'hh-1',
    deviceId: 'tv-1',
    deviceEvent,
    sendCard: async (card: unknown) => { cards.push(card); return true; },
    sendControl: async (control: Record<string, unknown>) => { controls.push(control); return true; },
    ...(synthesize ? { synthesize } : {}),
  });
  return { result, cards, controls, synthesize };
}

const read = (cardId: unknown, options?: Parameters<typeof television>[1]) => television({ t: 'read', cardId, at: 1_000 }, options);
const table = () => JSON.stringify([...aws.rows.entries()]);
const counters = () => [...aws.rows.values()].filter((item) => item.sk!.S!.startsWith('TRY#READ#'));

let said: string[] = [];

beforeEach(() => {
  home();
  aws.events.length = 0;
  aws.objects.clear();
  aws.s3.length = 0;
  said = [];
  for (const method of ['log', 'error', 'warn', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { said.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')); });
  }
});

afterEach(() => {
  // Whatever happened: nothing said aloud names the text, the address or the card.
  expect(said.join('\n')).not.toMatch(/X-Amz|https:\/\/|amazonaws|tts\/|note-1|door-1|Ring me|Sarah/);
  // And nothing about a reading ever goes on the bus.
  expect(aws.events).toEqual([]);
  vi.restoreAllMocks();
});

describe('{ t: "read" } — she presses Play on a card', () => {
  it('answers the television that asked, and only it, with the address of a reading of that card', async () => {
    storeNote();

    const tv = await read('note-1');

    expect(tv.result).toEqual({ statusCode: 200, body: '' });
    expect(tv.cards).toEqual([]);
    expect(tv.controls).toHaveLength(1);
    const [control] = tv.controls as [{ t: string; cardId: string; url: string }];
    expect({ t: control.t, cardId: control.cardId }).toEqual({ t: 'speech', cardId: 'note-1' });

    const { hash } = readingOf({ language: 'en', passages: ['Sarah.', 'Ring me tonight, Mum & Dad <3.', 'I will.', 'Not tonight.'] });
    const url = new URL(control.url);
    expect(url.host).toBe('wick-media-test.s3.us-east-1.amazonaws.com');
    expect(url.pathname).toBe(`/tts/hh-1/${hash}.mp3`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(SPEECH_URL_TTL_SEC));
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('test-session-token');
  });

  it('asks the voice once, for the card’s words as SSML, and keeps what it says as an mp3 under tts/', async () => {
    storeNote();

    const tv = await read('note-1');

    expect(tv.synthesize!.mock.calls.map(([input]) => input)).toEqual([
      { Engine: 'neural', OutputFormat: 'mp3', TextType: 'ssml', Text: NOTE_SSML, VoiceId: SPEECH_VOICES.en.voiceId, LanguageCode: SPEECH_VOICES.en.languageCode },
    ]);
    expect(aws.objects.size).toBe(1);
    const [[key, object]] = [...aws.objects.entries()] as [[string, { bytes: number[]; contentType: string }]];
    expect(key).toMatch(/^tts\/hh-1\/[0-9a-f]{64}\.mp3$/);
    expect(object).toEqual({ bytes: AUDIO, contentType: 'audio/mpeg' });
    expect(aws.s3.map((call) => [call.name, call.bucket])).toEqual([['Head', 'wick-media-test'], ['Put', 'wick-media-test']]);
  });

  it('writes nothing but the hour’s count: no timeline row, nothing on the card, nothing a family tool reads', async () => {
    storeNote();
    const before = new Map(aws.rows);

    await read('note-1');

    const added = [...aws.rows.entries()].filter(([key]) => !before.has(key));
    const changed = [...before.entries()].filter(([key, item]) => JSON.stringify(aws.rows.get(key)) !== JSON.stringify(item));
    expect(changed).toEqual([]);
    expect(added).toHaveLength(1);
    const [[key, counter]] = added as [[string, Row]];
    expect(key).toMatch(/^HH#hh-1\|TRY#READ#\d+$/);
    expect(Object.keys(counter).sort()).toEqual(['pk', 'sk', 'tries', 'ttl']);
    expect(counter.tries).toEqual({ N: '1' });
    expect([...aws.rows.keys()].some((k) => k.includes('EVT#'))).toBe(false);
  });

  it('makes the same reading once: the second asking finds it kept, and the voice is not asked again', async () => {
    storeNote();
    const first = await read('note-1');
    const second = await read('note-1');

    expect(first.synthesize).toHaveBeenCalledTimes(1);
    expect(second.synthesize).not.toHaveBeenCalled();
    expect(new URL(String(second.controls[0]!.url)).pathname).toBe(new URL(String(first.controls[0]!.url)).pathname);
    expect(aws.objects.size).toBe(1);
    expect(counters()[0]!.tries).toEqual({ N: '2' });
  });

  it('says nothing aloud of a reading that went well', async () => {
    storeNote();

    await read('note-1');

    expect(said).toEqual([]);
  });
});

describe('each household is read the card it sees', () => {
  it('a Spanish household: Wick’s sentences from the phrasebook, the note from the translation kept beside it, in the Spanish voice', async () => {
    home({ language: 'es' });
    storeNote({ tr_es: { S: '{"transcript":"Llámame esta noche, mamá."}' } });

    const tv = await read('note-1');

    expect(tv.synthesize!.mock.calls[0]![0]).toEqual({
      Engine: 'neural',
      OutputFormat: 'mp3',
      TextType: 'ssml',
      Text: '<speak>Sarah.<break time="600ms"/>Llámame esta noche, mamá.<break time="600ms"/>[es] I will.<break time="600ms"/>[es] Not tonight.</speak>',
      VoiceId: SPEECH_VOICES.es.voiceId,
      LanguageCode: SPEECH_VOICES.es.languageCode,
    });
    expect(tv.controls[0]!.url).toBeDefined();
    // The stored card is still the English it was written in.
    expect(JSON.parse(aws.rows.get(`${HH}|CARD#note-1`)!.data!.S!)).toEqual(queuedNote);
  });

  it('a note no translation was kept for is on her screen in English, and is read as it is — by the household’s one voice', async () => {
    home({ language: 'es' });
    storeNote();

    const tv = await read('note-1');

    expect(tv.synthesize!.mock.calls[0]![0]).toMatchObject({
      Text: '<speak>Sarah.<break time="600ms"/>Ring me tonight, Mum &amp; Dad &lt;3.<break time="600ms"/>[es] I will.<break time="600ms"/>[es] Not tonight.</speak>',
      VoiceId: SPEECH_VOICES.es.voiceId,
    });
  });

  it('the same card in two languages is two readings: one is never played for the other', async () => {
    storeNote({ tr_es: { S: '{"transcript":"Llámame esta noche, mamá."}' } });
    const english = await read('note-1');
    aws.rows.set(`${HH}|META`, { pk: { S: HH }, sk: { S: 'META' }, language: { S: 'es' } });
    const spanish = await read('note-1');

    expect(spanish.synthesize).toHaveBeenCalledTimes(1);
    expect(new URL(String(spanish.controls[0]!.url)).pathname).not.toBe(new URL(String(english.controls[0]!.url)).pathname);
    expect(aws.objects.size).toBe(2);
  });
});

describe('a card that is on her screen without being stored', () => {
  it('reads the Light card, built as it was built for her', async () => {
    const tv = await read('light');

    const { Text } = tv.synthesize!.mock.calls[0]![0];
    expect(Text.startsWith('<speak>Your light is on.<break time="600ms"/>Sarah can see that your day has begun')).toBe(true);
    expect(Text.endsWith('Leave it on.<break time="600ms"/>Put it out for today.</speak>')).toBe(true);
    expect(tv.controls).toEqual([{ t: 'speech', cardId: 'light', url: expect.any(String) }]);
    // And still nothing is stored for it.
    expect(aws.rows.has(`${HH}|CARD#light`)).toBe(false);
  });

  it('reads the offer her hold brought, before anything of it is stored', async () => {
    const tv = await read('reach-1789772257830');

    expect(tv.synthesize).toHaveBeenCalledTimes(1);
    expect(tv.synthesize!.mock.calls[0]![0].Text).toMatch(/^<speak>.*Sarah.*<\/speak>$/s);
    expect(tv.controls).toEqual([{ t: 'speech', cardId: 'reach-1789772257830', url: expect.any(String) }]);
    expect(aws.rows.has(`${HH}|CARD#reach-1789772257830`)).toBe(false);
  });
});

describe('when there is no reading, the answer is the same quiet one: no address — and nothing is counted, made or changed', () => {
  const nothing = async (cardId: string, arrange: () => void = () => {}) => {
    arrange();
    const before = table();

    const tv = await read(cardId);

    expect(tv.result).toEqual({ statusCode: 200, body: '' });
    expect(tv.controls).toEqual([{ t: 'speech', cardId }]);
    expect(tv.cards).toEqual([]);
    expect(tv.synthesize).not.toHaveBeenCalled();
    expect(aws.objects.size).toBe(0);
    expect(table()).toBe(before);
  };

  it('for a card that is not there', () => nothing('note-404'));

  it('for a card she has answered', () => nothing('note-1', () => storeNote({ actedAt: { N: '5' } })));

  it('for a door card whose visitor has gone', () =>
    nothing('door-1', () => put({ pk: { S: HH }, sk: { S: 'CARD#door-1' }, data: { S: JSON.stringify({ id: 'door-1', urgency: 'DOOR', queuedAt: 1, expiresAt: 2, shownCount: 0, card: { type: 'DOOR', id: 'door-1', line: 'Someone is at the door.', actions: [] } }) } })));

  it('for a card with nothing on it to read', () =>
    nothing('week-1', () => put({ pk: { S: HH }, sk: { S: 'CARD#week-1' }, data: { S: JSON.stringify({ id: 'week-1', urgency: 'DEFERRED', queuedAt: 1, shownCount: 0, card: { type: 'WEEK', id: 'week-1', text: '', actions: [] } }) } })));

  it('for an id that names something else in the table', () => nothing('../META'));

  it('when the voice cannot be reached: it is said once why, and never what', async () => {
    storeNote();
    const failing = vi.fn(async () => { throw Object.assign(new Error('Ring me tonight note-1'), { name: 'ServiceUnavailableException' }); }) as never;

    const tv = await read('note-1', { synthesize: failing });

    expect(tv.controls).toEqual([{ t: 'speech', cardId: 'note-1' }]);
    expect(aws.objects.size).toBe(0);
    expect(said).toHaveLength(1);
    expect(JSON.parse(said[0]!)).toEqual({ level: 'error', msg: 'reading_failed', reason: 'ServiceUnavailableException' });
  });

  it('when the runtime has no Polly client to load: no address, and the error’s name is logged', async () => {
    storeNote();

    // No voice handed in: the handler loads the SDK's own, which is not installed here.
    const tv = await read('note-1', { synthesize: null });

    expect(tv.result).toEqual({ statusCode: 200, body: '' });
    expect(tv.controls).toEqual([{ t: 'speech', cardId: 'note-1' }]);
    expect(said).toHaveLength(1);
    expect(JSON.parse(said[0]!)).toMatchObject({ level: 'error', msg: 'reading_failed', reason: expect.any(String) });
  });

  it('never throws to the television, even when it cannot be answered', async () => {
    storeNote();

    const result = await handleDeviceEvent({
      householdId: 'hh-1',
      deviceId: 'tv-1',
      deviceEvent: { t: 'read', cardId: 'note-1', at: 1 },
      sendCard: async () => true,
      sendControl: async () => { throw Object.assign(new Error('gone'), { name: 'GoneException' }); },
      synthesize: voice(),
    });

    expect(result).toEqual({ statusCode: 200, body: '' });
  });

  it('refuses what is not a card’s id at all', async () => {
    for (const cardId of [undefined, 7, '', 'x'.repeat(300)]) {
      const tv = await read(cardId);
      expect(tv.result).toEqual({ statusCode: 400, body: 'bad_device_event' });
      expect(tv.controls).toEqual([]);
    }
    expect(counters()).toEqual([]);
  });

  it('answers a television that has been revoked with nothing at all', async () => {
    storeNote();
    put({ pk: { S: HH }, sk: { S: 'DEV#tv-1' }, denylisted: { BOOL: true } });

    const tv = await read('note-1');

    expect(tv.result).toEqual({ statusCode: 403, body: 'revoked' });
    expect(tv.controls).toEqual([]);
    expect(tv.synthesize).not.toHaveBeenCalled();
  });
});

describe('thirty readings a household in an hour', () => {
  const thisHour = () => `TRY#READ#${Math.floor(Date.now() / 3_600_000)}`;

  it('reads the thirtieth', async () => {
    storeNote();
    put({ pk: { S: HH }, sk: { S: thisHour() }, tries: { N: '29' }, ttl: { N: '1' } });

    const tv = await read('note-1');

    expect(tv.controls[0]!.url).toBeDefined();
    expect(aws.rows.get(`${HH}|${thisHour()}`)!.tries).toEqual({ N: '30' });
  });

  it('answers the thirty-first with no address, and asks neither the bucket nor the voice', async () => {
    storeNote();
    put({ pk: { S: HH }, sk: { S: thisHour() }, tries: { N: '30' }, ttl: { N: '1' } });

    const tv = await read('note-1');

    expect(tv.controls).toEqual([{ t: 'speech', cardId: 'note-1' }]);
    expect(tv.synthesize).not.toHaveBeenCalled();
    expect(aws.s3).toEqual([]);
    expect(aws.rows.get(`${HH}|${thisHour()}`)!.tries).toEqual({ N: '30' });
    // Being past the bound is not an error, and is not said.
    expect(said).toEqual([]);
  });

  it('counts a reading that was already kept, too: the bound is on her asking', async () => {
    storeNote();
    await read('note-1');
    await read('note-1');
    await read('note-1');

    expect(counters()[0]!.tries).toEqual({ N: '3' });
  });
});
