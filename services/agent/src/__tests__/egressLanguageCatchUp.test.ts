/**
 * The television speaks her language — the cards she had not yet answered
 * when she chose it.
 *
 * Seen on a television: a note sent while the home was English, still
 * waiting when she said "Sí, en español", came back with Wick's words in
 * Spanish and its own text in English — half a card in each language, on
 * the first thing she saw after choosing. The edge replays a stored card in
 * her language but never asks a translator; so when her answer changes the
 * language, the agent plane translates what is waiting, keeps it beside
 * each card, and sends those cards again (egress.ts catchUpInLanguage).
 *
 * The table, the push and Amazon Translate are stand-ins.
 */
import { describe, expect, it, vi } from 'vitest';
import { GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { DEFAULT_POLICY } from '@wick/policy';
import { DOOR_CARD_TTL_MS, type Card, type CircleCard, type DeviceWireMessage, type DoorCard, type FreeText, type HouseholdLanguage, type LanguageCard, type MessageCard, type OtherLanguage, type QueuedCard } from '@wick/contracts';
import { CATCH_UP_BUDGET_MS, CATCH_UP_MAX_CARDS, cardItem, deviceEgress, type DeviceEgressDeps } from '../egress.js';
import type { TranslateCall } from '../language/translate.js';
// The edge's own replay of a stored card, through its one wrapper on the way out.
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { isReplayable, replayedCard } from '../../../edge-device/lambda/card-acted.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { inHerLanguage } from '../../../edge-device/lambda/language.mjs';

type Row = Record<string, AttributeValue>;

const NOW = 1_000_000;
const base = { householdId: 'hh-1', correlationId: 'corr-note', createdAt: 1 };

/** The note from the emulator: sent while the home was English, not yet answered. */
const note: MessageCard = {
  ...base,
  type: 'MESSAGE',
  id: 'note-1',
  fromName: 'Guest',
  transcript: 'Rose would like to show you her drawing on Saturday.',
  suggestedReplies: ['I would love that', 'Not this week', 'Thank you'],
  actions: [
    { id: 'reply_0', label: 'I would love that', kind: 'primary' },
    { id: 'reply_1', label: 'Not this week', kind: 'secondary' },
    { id: 'reply_2', label: 'Thank you', kind: 'secondary' },
  ],
};
const queuedNote: QueuedCard = { id: 'note-1', urgency: 'DEFERRED', card: note, queuedAt: 500, shownCount: 0 };
const NOTE_IN_SPANISH = 'A Rose le gustaría enseñarle su dibujo el sábado.';

const circle: CircleCard = { ...base, type: 'CIRCLE', id: 'circle-u2', personName: 'Tom', role: 'family', headline: 'Tom would like to join your family circle.', detail: 'If you allow it, Tom can see what you share.', actions: [{ id: 'allow', label: 'Allow', kind: 'primary' }] };
const question: LanguageCard = { ...base, type: 'LANGUAGE', id: 'language-es', language: 'es', headline: '¿Quiere que Wick le hable en español?', detail: 'Sarah asks whether this television should use Spanish.', actions: [{ id: 'yes', label: 'Sí, en español', kind: 'primary' }] };
const door: DoorCard = { ...base, type: 'DOOR', id: 'door-1', line: 'Maria is at the front door.', description: 'A woman in a red coat.', match: { personId: 'p1', name: 'Maria', basis: 'schedule', expectedToday: true, confidence: 0.9 }, actions: [{ id: 'dismiss', label: 'Not now', kind: 'dismiss' }] };

const queued = (card: Card, queuedAt: number, extra: Partial<QueuedCard> = {}): QueuedCard => ({ id: card.id, urgency: card.type === 'DOOR' ? 'DOOR' : 'DEFERRED', card, queuedAt, shownCount: 0, ...extra });

/** Wick's sentences are marked with the language; free text is replaced only by what is handed in. */
const marked = (language: OtherLanguage, sentence: string): string => `[${language}] ${sentence}`;
const phrasebook: DeviceEgressDeps['phrasebook'] = {
  freeTextOf: (card: Card): FreeText =>
    card.type === 'MESSAGE' ? (card.transcript === undefined ? {} : { transcript: card.transcript })
    : card.type === 'DOOR' ? (card.description === undefined ? {} : { description: card.description })
    : {},
  cardIn: (language, card, free = {}) =>
    (card.type === 'LANGUAGE'
      ? card
      : {
          ...card,
          ...('headline' in card ? { headline: marked(language, card.headline) } : {}),
          ...(card.type === 'DOOR' ? { line: marked(language, card.line) } : {}),
          ...free,
          actions: card.actions.map((action) => ({ ...action, label: marked(language, action.label) })),
        }) as Card,
  patchIn: (_language, patch) => patch,
  homeIn: (_language, home) => home,
};

const SPANISH: Record<string, string> = {
  [note.transcript!]: NOTE_IN_SPANISH,
  'A woman in a red coat.': 'Una mujer con un abrigo rojo.',
};
const translator = () => vi.fn<TranslateCall>(async (input) => ({ TranslatedText: Object.entries(SPANISH).reduce((text, [en, es]) => text.replace(en, es), input.Text.replace(/^Note (\d+)\.$/, 'Nota $1.')) }));

const keyOf = (key: Row): string => `${key.pk!.S}|${key.sk!.S}`;

interface Hooks {
  /** Just before the translation is kept: between the first reading of the cards and that write. */
  readonly beforeUpdate?: (table: Map<string, Row>, key: string) => void;
  /** Just after it is kept: between that write and the look that comes before the push. */
  readonly afterUpdate?: (table: Map<string, Row>, key: string) => void;
  /** Just after something is pushed: between the push and the look that comes after it. `nth` counts pushes from 1. */
  readonly afterPush?: (table: Map<string, Row>, message: DeviceWireMessage, nth: number) => void;
}

function world(options: { readonly language?: HouseholdLanguage; readonly translate?: TranslateCall; readonly rows?: readonly Row[]; readonly clock?: () => number } & Hooks = {}) {
  const table = new Map<string, Row>((options.rows ?? []).map((row) => [keyOf(row), row]));
  const commands: { readonly name: string; readonly input: Record<string, unknown> }[] = [];
  const pushed: { readonly bytes: string; readonly exceptDeviceId: string | undefined }[] = [];
  const said: Record<string, unknown>[] = [];
  const translate = (options.translate ?? translator()) as ReturnType<typeof translator>;
  let language: HouseholdLanguage = options.language ?? 'es';

  const send = async (command: unknown): Promise<unknown> => {
    const { input } = command as { input: Record<string, unknown> };
    commands.push({ name: (command as object).constructor.name, input });
    if (command instanceof PutItemCommand) {
      table.set(keyOf(command.input.Item as Row), command.input.Item as Row);
      return {};
    }
    if (command instanceof GetItemCommand) return { Item: table.get(keyOf(command.input.Key as Row)) };
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues as Row;
      const Items = [...table.values()].filter((row) => row.pk!.S === values[':pk']!.S && row.sk!.S!.startsWith(values[':prefix']!.S!)).sort((a, b) => (a.sk!.S! < b.sk!.S! ? -1 : 1));
      return { Items };
    }
    if (command instanceof UpdateItemCommand) {
      const { Key, UpdateExpression, ConditionExpression, ExpressionAttributeNames: names = {}, ExpressionAttributeValues: values = {} } = command.input;
      const key = keyOf(Key as Row);
      options.beforeUpdate?.(table, key);
      const row = table.get(key);
      // The one condition the catching-up makes: the card is there, still unanswered, and still the card that was read.
      expect(ConditionExpression).toBe('attribute_exists(pk) AND attribute_not_exists(actedAt) AND #data = :data');
      expect(UpdateExpression).toBe('SET #tr = :tr');
      if (!row || row.actedAt || row.data?.S !== values[':data']!.S) throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
      table.set(key, { ...row, [names['#tr']!]: values[':tr']! });
      options.afterUpdate?.(table, key);
      return {};
    }
    throw new Error(`unexpected command ${(command as object).constructor.name}`);
  };

  const egress = deviceEgress({
    table: 'wick',
    db: { send } as unknown as DeviceEgressDeps['db'],
    push: async (_householdId, payload, exceptDeviceId) => {
      const message = await payload;
      pushed.push({ bytes: JSON.stringify(message), exceptDeviceId });
      options.afterPush?.(table, message, pushed.length);
    },
    languageOf: async () => language,
    translate,
    phrasebook,
    now: options.clock ?? (() => NOW),
    log: (line) => { said.push(line); },
  });

  return {
    egress,
    table,
    commands,
    pushed,
    said,
    translate,
    sheSays: (next: HouseholdLanguage) => { language = next; },
    forget: () => { commands.length = 0; pushed.length = 0; said.length = 0; },
    row: (sk: string): Row | undefined => table.get(`HH#hh-1|${sk}`),
    cards: (): QueuedCard[] => pushed.flatMap(({ bytes }) => { const message = JSON.parse(bytes) as DeviceWireMessage; return message.kind === 'card' ? [message.card] : []; }),
    messages: (): DeviceWireMessage[] => pushed.map(({ bytes }) => JSON.parse(bytes) as DeviceWireMessage),
    snapshot: (): string => JSON.stringify([...table.entries()]),
    catchUp: (to: HouseholdLanguage = 'es') => egress.catchUpInLanguage('hh-1', to, { correlationId: 'corr-change' }),
  };
}

const stored = (card: QueuedCard, extra: Row = {}): Row => ({ ...cardItem(card), ...extra });

/** The edge's reconcile, for one stored row: what it would put on a television that asks for its cards. */
async function replayedByTheEdge(row: Row, language: HouseholdLanguage): Promise<QueuedCard> {
  const sent: QueuedCard[] = [];
  const voice = inHerLanguage({
    sendCard: async (card: QueuedCard) => { sent.push(card); return true; },
    sendControl: async () => true,
    readLanguage: async () => language,
    phrasebook,
    log: () => {},
  });
  expect(isReplayable(row, NOW)).toBe(true);
  await voice.sendCard(replayedCard(row), { row });
  return sent[0]!;
}

describe('the note from the emulator: sent while the home was English, unanswered when she says yes', () => {
  /** Sent through the same egress, while the household still read as English. */
  async function waitingNote() {
    const w = world({ language: 'en' });
    await w.egress.sendToDevice(queuedNote, DEFAULT_POLICY);
    expect(Object.keys(w.row('CARD#note-1')!).some((name) => name.startsWith('tr_'))).toBe(false);
    w.sheSays('es');
    w.forget();
    return w;
  }

  it('is translated once, kept beside the card, and sent again with its text in Spanish', async () => {
    const w = await waitingNote();
    const dataBefore = w.row('CARD#note-1')!.data!.S;

    const outcome = await w.catchUp();

    expect(outcome).toEqual({ waiting: 1, translated: 1, sent: 1 });
    // One call to the translator, for the note's own words, English to Spanish.
    expect(w.translate).toHaveBeenCalledTimes(1);
    expect(w.translate.mock.calls[0]![0]).toEqual({ Text: note.transcript, SourceLanguageCode: 'en', TargetLanguageCode: 'es' });
    // Kept beside the card; the card itself is the English it was written in, to the byte.
    expect(JSON.parse(w.row('CARD#note-1')!.tr_es!.S!)).toEqual({ transcript: NOTE_IN_SPANISH });
    expect(w.row('CARD#note-1')!.data!.S).toBe(dataBefore);
    expect(JSON.parse(dataBefore!)).toEqual(queuedNote);
    // Sent again, to every television of the home: the whole card in one language.
    expect(w.pushed.map((push) => push.exceptDeviceId)).toEqual([undefined]);
    const [again] = w.cards();
    expect(again!.card).toMatchObject({ type: 'MESSAGE', id: 'note-1', fromName: 'Guest', transcript: NOTE_IN_SPANISH });
    expect(again!.card.actions.map((action) => [action.id, action.label])).toEqual([
      ['reply_0', '[es] I would love that'],
      ['reply_1', '[es] Not this week'],
      ['reply_2', '[es] Thank you'],
    ]);
    expect(w.pushed[0]!.bytes).not.toContain('Rose would like');
  });

  it('is the same card on her television, not a new one: its id, when it was queued and how often it was shown are untouched', async () => {
    const w = await waitingNote();

    await w.catchUp();

    const [again] = w.cards();
    expect({ id: again!.id, urgency: again!.urgency, queuedAt: again!.queuedAt, shownCount: again!.shownCount }).toEqual({ id: 'note-1', urgency: 'DEFERRED', queuedAt: 500, shownCount: 0 });
    // Nothing is stored again: one update of the translation, and no card written — then a look before the push, and one after.
    expect(w.commands.map((command) => command.name)).toEqual(['QueryCommand', 'UpdateItemCommand', 'GetItemCommand', 'GetItemCommand']);
    expect((w.commands[1]!.input as { ExpressionAttributeNames: Record<string, string> }).ExpressionAttributeNames).toEqual({ '#tr': 'tr_es', '#data': 'data' });
  });

  it('is what the edge then replays, to the byte: a television that asks for its cards after this gets the very card that was sent', async () => {
    const w = await waitingNote();
    // She had it on screen once already, counted by the edge.
    w.table.set('HH#hh-1|CARD#note-1', { ...w.row('CARD#note-1')!, shown: { N: '1' } });

    await w.catchUp();

    const replay = await replayedByTheEdge(w.row('CARD#note-1')!, 'es');
    expect(JSON.stringify(w.cards()[0])).toBe(JSON.stringify(replay));
    expect(w.cards()[0]!.shownCount).toBe(1);
  });

  it('leaves the family the reply she chooses in the words Wick offered: the stored replies are the English ones still', async () => {
    const w = await waitingNote();

    await w.catchUp();

    expect((JSON.parse(w.row('CARD#note-1')!.data!.S!) as QueuedCard).card).toMatchObject({ suggestedReplies: ['I would love that', 'Not this week', 'Thank you'] });
  });

  it('says what it did by numbers and the change’s own id — never a word of a card, or which', async () => {
    const w = await waitingNote();

    await w.catchUp();

    expect(w.said).toEqual([{ level: 'info', msg: 'cards_put_in_her_language', correlationId: 'corr-change', language: 'es', waiting: 1, translated: 1, sent: 1 }]);
  });
});

describe('what is left alone', () => {
  const untouched = async (rows: readonly Row[]) => {
    const w = world({ rows });
    const before = w.snapshot();

    const outcome = await w.catchUp();

    expect(w.translate).not.toHaveBeenCalled();
    expect(w.pushed).toEqual([]);
    expect(w.snapshot()).toBe(before);
    return outcome;
  };

  it('a card she has answered', async () => {
    expect(await untouched([stored(queuedNote, { actedAt: { N: '900' } })])).toEqual({ waiting: 0, translated: 0, sent: 0 });
  });

  it('a card with no free text: every word of it is Wick’s, and the edge’s replay already has those', async () => {
    expect(await untouched([stored(queued(circle, 600))])).toEqual({ waiting: 1, translated: 0, sent: 0 });
  });

  it('the language question itself, which is never put through anything', async () => {
    await untouched([stored(queued(question, 600))]);
  });

  it('a card that already has its translation beside it', async () => {
    await untouched([stored(queuedNote, { tr_es: { S: JSON.stringify({ transcript: NOTE_IN_SPANISH }) } })]);
  });

  it('a door card whose visitor has gone', async () => {
    await untouched([stored(queued(door, NOW - DOOR_CARD_TTL_MS - 1))]);
    await untouched([stored(queued(door, NOW - 10, { expiresAt: NOW }))]);
  });

  it('a note with no words in it', async () => {
    await untouched([stored(queued({ ...note, transcript: '   ' }, 600))]);
  });

  it('a row that is not a card at all', async () => {
    await untouched([{ pk: { S: 'HH#hh-1' }, sk: { S: 'CARD#broken' }, data: { S: 'not json' } }, { pk: { S: 'HH#hh-1' }, sk: { S: 'CARD#empty' } }]);
  });

  it('another household’s cards', async () => {
    const theirs = { ...note, householdId: 'hh-2' };
    await untouched([{ ...cardItem(queued(theirs, 600)) }]);
  });
});

describe('a door card still at the door is caught up too, its visitor’s name left as it is', () => {
  it('translates the description and sends the card again', async () => {
    const w = world({ rows: [stored(queued(door, NOW - 1000, { expiresAt: NOW + 60_000 }))] });

    expect(await w.catchUp()).toEqual({ waiting: 1, translated: 1, sent: 1 });

    expect(JSON.parse(w.row('CARD#door-1')!.tr_es!.S!)).toEqual({ description: 'Una mujer con un abrigo rojo.' });
    expect(w.cards()[0]!.card).toMatchObject({ line: '[es] Maria is at the front door.', description: 'Una mujer con un abrigo rojo.' });
  });
});

describe('the bound: a change of language is not a reason to work through everything she ever left unanswered', () => {
  const notes = Array.from({ length: CATCH_UP_MAX_CARDS + 5 }, (_, i) => queued({ ...note, id: `note-${i + 1}`, transcript: `Note ${i + 1}.` }, 100 + i));

  it('takes the twenty newest unanswered cards, and leaves the older ones as they were', async () => {
    expect(CATCH_UP_MAX_CARDS).toBe(20);
    const w = world({ rows: notes.map((card) => stored(card)) });

    const outcome = await w.catchUp();

    expect(outcome).toEqual({ waiting: 25, translated: 20, sent: 20 });
    expect(w.translate).toHaveBeenCalledTimes(20);
    const translated = notes.filter((card) => w.row(`CARD#${card.id}`)!.tr_es).map((card) => card.id);
    expect(translated).toEqual(notes.slice(5).map((card) => card.id));
    expect(w.cards().map((card) => card.id).sort()).toEqual(translated.sort());
  });

  it('has one time budget for all of them — six seconds — and a card not translated in it is left as it was', async () => {
    expect(CATCH_UP_BUDGET_MS).toBe(6000);
    vi.useFakeTimers();
    try {
      // The first note is answered at once; every other never.
      const slow = vi.fn<TranslateCall>((input) => (input.Text === 'Note 25.' ? Promise.resolve({ TranslatedText: 'Nota 25.' }) : new Promise(() => {})));
      const w = world({ rows: notes.map((card) => stored(card)), translate: slow });
      let outcome: unknown = 'pending';
      void w.catchUp().then((done) => { outcome = done; });

      await vi.advanceTimersByTimeAsync(5999);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);

      expect(outcome).toEqual({ waiting: 25, translated: 1, sent: 1 });
      expect(w.cards().map((card) => card.id)).toEqual(['note-25']);
      expect(notes.filter((card) => w.row(`CARD#${card.id}`)!.tr_es).map((card) => card.id)).toEqual(['note-25']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('when a translation is not to be had', () => {
  it('leaves that card exactly as it was — its text in English under Wick’s Spanish words, as before — and still does the others', async () => {
    const failing = vi.fn<TranslateCall>(async (input) => {
      if (input.Text.includes('Rose')) throw Object.assign(new Error('down'), { name: 'ServiceUnavailableException' });
      return { TranslatedText: 'Una mujer con un abrigo rojo.' };
    });
    const w = world({ rows: [stored(queuedNote), stored(queued(door, NOW - 1000, { expiresAt: NOW + 60_000 }))], translate: failing });
    const noteBefore = JSON.stringify(w.row('CARD#note-1'));

    const outcome = await w.catchUp();

    expect(outcome).toEqual({ waiting: 2, translated: 1, sent: 1 });
    expect(JSON.stringify(w.row('CARD#note-1'))).toBe(noteBefore);
    expect(w.cards().map((card) => card.id)).toEqual(['door-1']);
  });

  it('never throws: a table that cannot be read is said, and nothing more', async () => {
    const egress = deviceEgress({
      table: 'wick',
      db: { send: async () => { throw Object.assign(new Error('for hh-1'), { name: 'ProvisionedThroughputExceededException' }); } } as unknown as DeviceEgressDeps['db'],
      push: async () => {},
      languageOf: async () => 'es',
      translate: vi.fn(),
      phrasebook,
      log: () => {},
    });

    expect(await egress.catchUpInLanguage('hh-1', 'es', { correlationId: 'c' })).toEqual({ waiting: 0, translated: 0, sent: 0 });
  });
});

describe('when there is nothing to do', () => {
  it('a change to English does nothing at all: the stored card is English, and the edge’s replay shows it', async () => {
    const w = world({ language: 'en', rows: [stored(queuedNote)] });

    expect(await w.catchUp('en')).toEqual({ waiting: 0, translated: 0, sent: 0 });

    expect(w.commands).toEqual([]);
    expect(w.pushed).toEqual([]);
    expect(w.translate).not.toHaveBeenCalled();
  });

  it('a change the household has since undone does nothing: the row, read now, is what counts — not what the event said', async () => {
    const w = world({ language: 'en', rows: [stored(queuedNote)] });

    expect(await w.catchUp('es')).toEqual({ waiting: 0, translated: 0, sent: 0 });

    expect(w.translate).not.toHaveBeenCalled();
    expect(w.pushed).toEqual([]);
    expect(w.row('CARD#note-1')!.tr_es).toBeUndefined();
  });
});

describe('the same event delivered twice', () => {
  it('translates nothing the second time, writes nothing, and what is stored is what the first left', async () => {
    const w = world({ rows: [stored(queuedNote)] });
    await w.catchUp();
    const after = w.snapshot();
    w.forget();

    const again = await w.catchUp();

    expect(again).toEqual({ waiting: 1, translated: 0, sent: 0 });
    expect(w.translate).toHaveBeenCalledTimes(1);
    expect(w.commands.map((command) => command.name)).toEqual(['QueryCommand']);
    expect(w.snapshot()).toBe(after);
  });
});

describe('a card that changes while it is being translated', () => {
  it('answered in the meantime: its translation is not stored, and it is not sent to a television that has put it away', async () => {
    const w = world({ rows: [stored(queuedNote)], beforeUpdate: (table, key) => { table.set(key, { ...table.get(key)!, actedAt: { N: '999' } }); } });

    expect(await w.catchUp()).toEqual({ waiting: 1, translated: 0, sent: 0 });

    expect(w.row('CARD#note-1')!.tr_es).toBeUndefined();
    expect(w.pushed).toEqual([]);
  });

  it('patched in the meantime: a translation of words the card no longer has is not kept or sent', async () => {
    const described = queued(door, NOW - 1000, { expiresAt: NOW + 60_000 });
    const w = world({
      rows: [stored(described)],
      beforeUpdate: (table, key) => { table.set(key, { ...table.get(key)!, data: { S: JSON.stringify({ ...described, card: { ...door, description: 'A man holding a parcel.' } }) } }); },
    });

    expect(await w.catchUp()).toEqual({ waiting: 1, translated: 0, sent: 0 });

    expect(w.row('CARD#door-1')!.tr_es).toBeUndefined();
    expect(w.pushed).toEqual([]);
  });
});

describe('nothing finished is put back on her screen — the card is looked at again at the moment of pushing, and once more after', () => {
  const answered = (table: Map<string, Row>, key: string) => { table.set(key, { ...table.get(key)!, actedAt: { N: '999' } }); };
  const NOTE = 'HH#hh-1|CARD#note-1';
  const revokes = (w: ReturnType<typeof world>) => w.messages().flatMap((message) => (message.kind === 'control' && message.control.t === 'revoke' ? [message.control.cardId] : []));

  it('looks at the row as it is that instant, both times: consistent reads of that one card', async () => {
    const w = world({ rows: [stored(queuedNote)] });

    await w.catchUp();

    const looks = w.commands.filter((command) => command.name === 'GetItemCommand').map((command) => command.input);
    expect(looks).toEqual([
      { TableName: 'wick', Key: { pk: { S: 'HH#hh-1' }, sk: { S: 'CARD#note-1' } }, ConsistentRead: true },
      { TableName: 'wick', Key: { pk: { S: 'HH#hh-1' }, sk: { S: 'CARD#note-1' } }, ConsistentRead: true },
    ]);
    // One before the push, one after it.
    const order = w.commands.map((command) => command.name);
    expect(order.indexOf('GetItemCommand')).toBeGreaterThan(order.indexOf('UpdateItemCommand'));
    expect(w.cards()).toHaveLength(1);
    expect(revokes(w)).toEqual([]);
  });

  it('a card whose translation could not be kept — answered before it was — is never pushed', async () => {
    const w = world({ rows: [stored(queuedNote)], beforeUpdate: answered });

    expect(await w.catchUp()).toEqual({ waiting: 1, translated: 0, sent: 0 });

    expect(w.pushed).toEqual([]);
    // Not even looked at again: there is nothing to send.
    expect(w.commands.filter((command) => command.name === 'GetItemCommand')).toEqual([]);
  });

  it('answered between the translation being kept and the push: not pushed', async () => {
    const w = world({ rows: [stored(queuedNote)], afterUpdate: answered });

    expect(await w.catchUp()).toEqual({ waiting: 1, translated: 1, sent: 0 });

    expect(w.pushed).toEqual([]);
  });

  it('answered between the push and the look after it: taken back off her televisions, the way a withdrawn card is', async () => {
    const w = world({ rows: [stored(queuedNote)], afterPush: (table, _message, nth) => { if (nth === 1) answered(table, NOTE); } });

    expect(await w.catchUp()).toEqual({ waiting: 1, translated: 1, sent: 0 });

    expect(w.messages().map((message) => (message.kind === 'card' ? `card ${message.card.id}` : `${message.control.t} ${'cardId' in message.control ? message.control.cardId : ''}`))).toEqual(['card note-1', 'revoke note-1']);
    // To every television of the home: whichever of them was pressed, each may have been handed the copy.
    expect(w.pushed.map((push) => push.exceptDeviceId)).toEqual([undefined, undefined]);
  });

  it('taken back by its sender before the push — the row gone altogether: not pushed, and nothing to take back', async () => {
    const w = world({ rows: [stored(queuedNote)], afterUpdate: (table, key) => { table.delete(key); } });

    expect(await w.catchUp()).toEqual({ waiting: 1, translated: 1, sent: 0 });

    expect(w.pushed).toEqual([]);
  });

  it('gone after the push: taken back', async () => {
    const w = world({ rows: [stored(queuedNote)], afterPush: (table, _message, nth) => { if (nth === 1) table.delete(NOTE); } });

    expect(await w.catchUp()).toEqual({ waiting: 1, translated: 1, sent: 0 });

    expect(revokes(w)).toEqual(['note-1']);
  });

  it('a door card whose visitor has gone by the time of pushing is not pushed', async () => {
    const times = [NOW, NOW + 10 * 60_000];
    const w = world({ rows: [stored(queued(door, NOW - 1000, { expiresAt: NOW + 60_000 }))], clock: () => times.shift() ?? NOW + 10 * 60_000 });

    expect(await w.catchUp()).toEqual({ waiting: 1, translated: 1, sent: 0 });

    expect(w.pushed).toEqual([]);
  });

  it('changed between the translation being kept and the push — its words patched: not pushed; whoever changed it sent the change', async () => {
    const described = queued(door, NOW - 1000, { expiresAt: NOW + 60_000 });
    const w = world({
      rows: [stored(described)],
      afterUpdate: (table, key) => { table.set(key, { ...table.get(key)!, data: { S: JSON.stringify({ ...described, card: { ...door, notice: 'The hallway chime rang.' } }) } }); },
    });

    expect(await w.catchUp()).toEqual({ waiting: 1, translated: 1, sent: 0 });

    expect(w.pushed).toEqual([]);
  });

  it('changed between the push and the look after it: sent once more as it now stands, so the copy just pushed does not hide the change', async () => {
    const described = queued(door, NOW - 1000, { expiresAt: NOW + 60_000 });
    const patched = { ...described, card: { ...door, notice: 'The hallway chime rang.' } };
    const w = world({
      rows: [stored(described)],
      afterPush: (table, _message, nth) => { if (nth === 1) table.set('HH#hh-1|CARD#door-1', { ...table.get('HH#hh-1|CARD#door-1')!, data: { S: JSON.stringify(patched) } }); },
    });

    expect(await w.catchUp()).toEqual({ waiting: 1, translated: 1, sent: 1 });

    expect(w.cards()).toHaveLength(2);
    expect(w.cards()[0]!.card).not.toHaveProperty('notice');
    expect(w.cards()[1]!.card).toMatchObject({ notice: 'The hallway chime rang.', description: 'Una mujer con un abrigo rojo.', line: '[es] Maria is at the front door.' });
    // And that is what the edge would replay from the row as it now is.
    expect(JSON.stringify(w.cards()[1])).toBe(JSON.stringify(await replayedByTheEdge(w.row('CARD#door-1')!, 'es')));
    expect(revokes(w)).toEqual([]);
  });

  it('changed and then answered: the last word is a take-back', async () => {
    const w = world({
      rows: [stored(queuedNote)],
      afterPush: (table, _message, nth) => {
        if (nth === 1) table.set(NOTE, { ...table.get(NOTE)!, shown: { N: '2' }, data: { S: JSON.stringify({ ...queuedNote, queuedAt: 501 }) } });
        if (nth === 2) answered(table, NOTE);
      },
    });

    expect(await w.catchUp()).toEqual({ waiting: 1, translated: 1, sent: 0 });

    expect(w.messages().map((message) => message.kind === 'card' ? 'card' : message.control.t)).toEqual(['card', 'card', 'revoke']);
  });
});

describe('an opposite answer while the cards are being caught up', () => {
  it('she went back to English before the push: nothing is pushed in the language she has left', async () => {
    // Back to English the instant the translation is kept.
    const w = world({ rows: [stored(queuedNote)], afterUpdate: () => { w.sheSays('en'); } });

    expect(await w.catchUp()).toEqual({ waiting: 1, translated: 1, sent: 0 });

    expect(w.pushed).toEqual([]);
  });

  it('she went back to English just after the push: the card is sent once more as it now stands — in English, to the byte', async () => {
    const w = world({ rows: [stored(queuedNote)], afterPush: (_table, _message, nth) => { if (nth === 1) w.sheSays('en'); } });

    await w.catchUp();

    expect(w.cards()).toHaveLength(2);
    expect(w.cards()[0]!.card).toMatchObject({ transcript: NOTE_IN_SPANISH });
    expect(JSON.stringify(w.cards()[1])).toBe(JSON.stringify(queuedNote));
  });

  it('she had already gone back when the event arrived: nothing at all', async () => {
    const w = world({ language: 'en', rows: [stored(queuedNote)] });

    expect(await w.catchUp('es')).toEqual({ waiting: 0, translated: 0, sent: 0 });

    expect(w.translate).not.toHaveBeenCalled();
    expect(w.pushed).toEqual([]);
  });
});
