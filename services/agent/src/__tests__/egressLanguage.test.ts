/**
 * The television speaks her language — what egress.ts sends, writes and
 * does not write (packages/contracts language.ts).
 *
 * The table, the push and Amazon Translate are stand-ins handed to
 * `deviceEgress`; the phrasebook is a small one of this file's own, so
 * these tests hold whatever its sentences come to be.
 */
import { describe, expect, it, vi } from 'vitest';
import { GetItemCommand, PutItemCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { DEFAULT_POLICY } from '@wick/policy';
import type { Card, CardPatch, DeviceWireMessage, DoorCard, FreeText, HomeState, HouseholdLanguage, MessageCard, OtherLanguage, QueuedCard, WeekCard } from '@wick/contracts';
import { cardItem, deviceEgress, translationAttribute, type DeviceEgressDeps } from '../egress.js';
import type { TranslateCall } from '../language/translate.js';
// The edge's own reading of a stored note, and of a stored card it sends again.
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { replyText } from '../../../edge-device/lambda/note-reply.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { isReplayable, replayedCard } from '../../../edge-device/lambda/card-acted.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { inHerLanguage } from '../../../edge-device/lambda/language.mjs';

type Row = Record<string, AttributeValue>;

const base = { householdId: 'hh-1', correlationId: 'corr-1', createdAt: 1 };

const door: DoorCard = {
  ...base,
  type: 'DOOR',
  id: 'door-1',
  line: "Someone's at the front door.",
  imageRef: 'https://media.example/door-1.jpg',
  actions: [
    { id: 'watch_live', label: 'Watch live', kind: 'primary' },
    { id: 'dismiss', label: 'Not now', kind: 'dismiss' },
  ],
};
const queuedDoor: QueuedCard = { id: 'door-1', urgency: 'DOOR', card: door, queuedAt: 1, expiresAt: 300_000, shownCount: 0 };

const note: MessageCard = {
  ...base,
  type: 'MESSAGE',
  id: 'note-1',
  fromName: 'Sarah',
  transcript: 'Ring me tonight, Mum.',
  suggestedReplies: ['I will', 'Not tonight', 'Thank you'],
  actions: [
    { id: 'reply_0', label: 'I will', kind: 'primary' },
    { id: 'reply_1', label: 'Not tonight', kind: 'secondary' },
    { id: 'reply_2', label: 'Thank you', kind: 'secondary' },
  ],
};
const queuedNote: QueuedCard = { id: 'note-1', urgency: 'DEFERRED', card: note, queuedAt: 2, shownCount: 0 };

const week: WeekCard = { ...base, type: 'WEEK', id: 'week-2026-W41', isoWeek: '2026-W41', text: 'A quiet week. Maria came twice.', actions: [{ id: 'seen', label: 'OK', kind: 'primary' }] };
const queuedWeek: QueuedCard = { id: week.id, urgency: 'DEFERRED', card: week, queuedAt: 3, shownCount: 0 };

/** A phrasebook of this file's own: Wick's sentences are marked with the language, free text is replaced only by what is handed in. */
const marked = (language: OtherLanguage, sentence: string): string => `[${language}] ${sentence}`;
const phrasebook: DeviceEgressDeps['phrasebook'] = {
  freeTextOf: (card: Card): FreeText =>
    card.type === 'MESSAGE' ? (card.transcript === undefined ? {} : { transcript: card.transcript })
    : card.type === 'DOOR' ? (card.description === undefined ? {} : { description: card.description })
    : card.type === 'WEEK' ? { text: card.text }
    : {},
  cardIn: (language, card, free = {}) =>
    ({
      ...card,
      ...(card.type === 'DOOR' ? { line: marked(language, card.line) } : {}),
      ...free,
      actions: card.actions.map((action) => ({ ...action, label: marked(language, action.label) })),
    }) as Card,
  patchIn: (language, patch, free = {}) => ({ ...patch, ...(patch.notice === undefined ? {} : { notice: marked(language, patch.notice) }), ...free }),
  homeIn: (language, home) => ({ ...home, ...(home.lookedIn ? { lookedIn: { ...home.lookedIn, line: marked(language, home.lookedIn.line) } } : {}) }),
};

const spanish: Record<string, string> = {
  'Ring me tonight, Mum.': 'Llámame esta noche, mamá.',
  'A quiet week. Maria came twice.': 'Una semana tranquila. Maria vino dos veces.',
  'A man holding a parcel.': 'Un hombre con un paquete.',
  'A woman in a red coat.': 'Una mujer con un abrigo rojo.',
};
/** Amazon Translate, standing in: it answers for the sentences above and for nothing else. */
const translator = (): TranslateCall & ReturnType<typeof vi.fn> =>
  vi.fn(async (input: { Text: string }) => ({ TranslatedText: Object.entries(spanish).reduce((text, [en, es]) => text.replace(en, es), input.Text) })) as never;
const broken = (): TranslateCall & ReturnType<typeof vi.fn> =>
  vi.fn(async () => { throw Object.assign(new Error('down'), { name: 'ServiceUnavailableException' }); }) as never;

const keyOf = (key: Row): string => `${key.pk!.S}|${key.sk!.S}`;

function world(options: { readonly language?: HouseholdLanguage; readonly translate?: TranslateCall; readonly rows?: readonly Row[] } = {}) {
  const table = new Map<string, Row>((options.rows ?? []).map((row) => [keyOf(row), row]));
  const sent: unknown[] = [];
  const pushed: { readonly householdId: string; readonly bytes: string; readonly exceptDeviceId: string | undefined }[] = [];
  const asked: string[] = [];
  const translate = (options.translate ?? translator()) as TranslateCall & ReturnType<typeof vi.fn>;

  const send = async (command: unknown): Promise<unknown> => {
    sent.push(command);
    if (command instanceof PutItemCommand) {
      table.set(keyOf(command.input.Item as Row), command.input.Item as Row);
      return {};
    }
    if (command instanceof GetItemCommand) return { Item: table.get(keyOf(command.input.Key as Row)) };
    if (command instanceof UpdateItemCommand) {
      const { Key, UpdateExpression = '', ExpressionAttributeNames: names = {}, ExpressionAttributeValues: values = {} } = command.input;
      const row = { ...(table.get(keyOf(Key as Row)) ?? (Key as Row)) };
      const [, set = '', remove = ''] = /^(?:SET (.*?))?(?: ?REMOVE (.*))?$/.exec(UpdateExpression) ?? [];
      for (const assignment of set.split(',').map((part) => part.trim()).filter(Boolean)) {
        const [name, value] = assignment.split('=').map((part) => part.trim()) as [string, string];
        row[names[name] ?? name] = values[value]!;
      }
      for (const name of remove.split(',').map((part) => part.trim()).filter(Boolean)) delete row[names[name] ?? name];
      table.set(keyOf(Key as Row), row);
      return {};
    }
    throw new Error(`unexpected command ${(command as object).constructor.name}`);
  };

  const egress = deviceEgress({
    table: 'wick',
    db: { send } as unknown as DeviceEgressDeps['db'],
    push: async (householdId, payload, exceptDeviceId) => {
      pushed.push({ householdId, bytes: JSON.stringify(await payload), exceptDeviceId });
    },
    languageOf: async (householdId) => {
      asked.push(householdId);
      return options.language ?? 'en';
    },
    translate,
    phrasebook,
    log: () => {},
  });

  return {
    egress,
    table,
    sent,
    pushed,
    asked,
    translate,
    row: (sk: string): Row | undefined => table.get(`HH#hh-1|${sk}`),
    message: (index = 0): DeviceWireMessage => JSON.parse(pushed[index]!.bytes) as DeviceWireMessage,
  };
}

const stored = (queued: QueuedCard, extra: Row = {}): Row => ({ ...cardItem(queued), ...extra });

describe('an English household — nothing is different, to the byte', () => {
  it('writes the row it always wrote and pushes the bytes it always pushed, for a door card', async () => {
    const w = world();

    await w.egress.sendToDevice(queuedDoor, DEFAULT_POLICY, { ringDeviceId: 'ava1.ring.device.X' });

    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toBeInstanceOf(PutItemCommand);
    expect((w.sent[0] as PutItemCommand).input).toEqual({
      TableName: 'wick',
      Item: {
        pk: { S: 'HH#hh-1' },
        sk: { S: 'CARD#door-1' },
        data: {
          S: '{"id":"door-1","urgency":"DOOR","card":{"householdId":"hh-1","correlationId":"corr-1","createdAt":1,"type":"DOOR","id":"door-1","line":"Someone\'s at the front door.","imageRef":"https://media.example/door-1.jpg","actions":[{"id":"watch_live","label":"Watch live","kind":"primary"},{"id":"dismiss","label":"Not now","kind":"dismiss"}]},"queuedAt":1,"expiresAt":300000,"shownCount":0}',
        },
        ttl: { N: '300' },
        ringDeviceId: { S: 'ava1.ring.device.X' },
      },
      // The same row, written once: a ring handled twice never puts the bare card back (egressDoorRetry.test.ts).
      ConditionExpression: 'attribute_not_exists(sk)',
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
    expect(w.pushed).toEqual([
      {
        householdId: 'hh-1',
        exceptDeviceId: undefined,
        bytes:
          '{"kind":"card","card":{"id":"door-1","urgency":"DOOR","card":{"householdId":"hh-1","correlationId":"corr-1","createdAt":1,"type":"DOOR","id":"door-1","line":"Someone\'s at the front door.","imageRef":"https://media.example/door-1.jpg","actions":[{"id":"watch_live","label":"Watch live","kind":"primary"},{"id":"dismiss","label":"Not now","kind":"dismiss"}]},"queuedAt":1,"expiresAt":300000,"shownCount":0}}',
      },
    ]);
    expect(w.translate).not.toHaveBeenCalled();
  });

  it('does the same for a card with free text in it: a note is stored and pushed as it was written, and no translator is asked', async () => {
    const w = world();

    await w.egress.sendToDevice(queuedNote, DEFAULT_POLICY);

    expect(w.sent.map((command) => (command as object).constructor.name)).toEqual(['PutItemCommand']);
    expect((w.sent[0] as PutItemCommand).input).toEqual({ TableName: 'wick', Item: cardItem(queuedNote) });
    expect(Object.keys(w.row('CARD#note-1')!).sort()).toEqual(['data', 'pk', 'sk']);
    expect(w.pushed[0]!.bytes).toBe(JSON.stringify({ kind: 'card', card: queuedNote }));
    expect(w.pushed[0]!.bytes).toContain('"transcript":"Ring me tonight, Mum."');
    expect(w.translate).not.toHaveBeenCalled();
  });

  it('merges a patch into the stored card and pushes it, with the one update it always made', async () => {
    const w = world({ rows: [stored(queuedDoor)] });
    const patch: CardPatch = { cardId: 'door-1', description: 'A man holding a parcel.' };

    await w.egress.sendPatchToDevice(patch, 'hh-1');

    expect(w.sent.map((command) => (command as object).constructor.name)).toEqual(['GetItemCommand', 'UpdateItemCommand']);
    expect((w.sent[0] as GetItemCommand).input).toEqual({ TableName: 'wick', Key: { pk: { S: 'HH#hh-1' }, sk: { S: 'CARD#door-1' } } });
    expect((w.sent[1] as UpdateItemCommand).input).toEqual({
      TableName: 'wick',
      Key: { pk: { S: 'HH#hh-1' }, sk: { S: 'CARD#door-1' } },
      UpdateExpression: 'SET #data = :data',
      ExpressionAttributeNames: { '#data': 'data' },
      ExpressionAttributeValues: { ':data': { S: JSON.stringify({ ...queuedDoor, card: { ...door, description: 'A man holding a parcel.' } }) } },
    });
    expect(w.pushed).toEqual([
      { householdId: 'hh-1', exceptDeviceId: undefined, bytes: '{"kind":"control","control":{"t":"patch","patch":{"cardId":"door-1","description":"A man holding a parcel."}}}' },
    ]);
    expect(w.translate).not.toHaveBeenCalled();
  });

  it('tells the home screen what it was given, whole or in part, and writes nothing', async () => {
    const w = world();
    const look: HomeState = { lookedIn: { name: 'Sarah', at: 5, line: 'Sarah looked in this morning.', until: 9 } };

    await w.egress.sendHomeToDevices('hh-1', look);
    await w.egress.sendHomeToDevices('hh-1', { light: 'on' }, { whole: true, exceptDeviceId: 'tv-1' });

    expect(w.sent).toEqual([]);
    expect(w.pushed).toEqual([
      { householdId: 'hh-1', exceptDeviceId: undefined, bytes: '{"kind":"control","control":{"t":"home","home":{"lookedIn":{"name":"Sarah","at":5,"line":"Sarah looked in this morning.","until":9}}}}' },
      { householdId: 'hh-1', exceptDeviceId: 'tv-1', bytes: '{"kind":"control","control":{"t":"home","home":{"light":"on"},"whole":true}}' },
    ]);
  });
});

describe('a household whose television speaks Spanish — a card on its way out', () => {
  it('keeps the stored card English and pushes it in her language: Wick’s own sentences from the phrasebook, the note’s words from the translator', async () => {
    const w = world({ language: 'es' });

    await w.egress.sendToDevice(queuedNote, DEFAULT_POLICY);

    // The row: the English card, exactly, and the translation beside it — one write.
    expect(w.sent.map((command) => (command as object).constructor.name)).toEqual(['PutItemCommand']);
    const row = w.row('CARD#note-1')!;
    expect(row.data).toEqual(cardItem(queuedNote).data);
    expect(JSON.parse(row.data!.S!)).toEqual(queuedNote);
    expect(translationAttribute('es')).toBe('tr_es');
    expect(JSON.parse(row.tr_es!.S!)).toEqual({ transcript: 'Llámame esta noche, mamá.' });

    // The push: not the English.
    const message = w.message();
    expect(message.kind === 'card' && message.card).toMatchObject({
      id: 'note-1',
      urgency: 'DEFERRED',
      queuedAt: 2,
      shownCount: 0,
      card: { type: 'MESSAGE', id: 'note-1', fromName: 'Sarah', transcript: 'Llámame esta noche, mamá.', suggestedReplies: note.suggestedReplies },
    });
    expect(message.kind === 'card' && message.card.card.actions.map((action) => [action.id, action.label])).toEqual([
      ['reply_0', '[es] I will'],
      ['reply_1', '[es] Not tonight'],
      ['reply_2', '[es] Thank you'],
    ]);
    expect(w.pushed[0]!.bytes).not.toContain('Ring me tonight');
  });

  it('asks the translator once for the note, plain, from English to Spanish — and takes the answer, the sender’s name having come through', async () => {
    const w = world({ language: 'es' });

    await w.egress.sendToDevice({ ...queuedNote, card: { ...note, transcript: 'Ring me tonight, Mum. Sarah' } }, DEFAULT_POLICY);

    expect(w.translate).toHaveBeenCalledTimes(1);
    expect(w.translate.mock.calls[0]![0]).toEqual({ Text: 'Ring me tonight, Mum. Sarah', SourceLanguageCode: 'en', TargetLanguageCode: 'es' });
    const message = w.message();
    expect(message.kind === 'card' && message.card.card).toMatchObject({ transcript: 'Llámame esta noche, mamá. Sarah' });
  });

  it('asks once more with her name marked when the plain answer changed it, and uses that', async () => {
    const translate = vi.fn(async (input: { Text: string }) => ({
      TranslatedText: input.Text.includes('<span') ? 'Llámame esta noche, mamá. <span translate="no">Sarah</span>' : 'Llámame esta noche, mamá. Sara',
    })) as never as TranslateCall & ReturnType<typeof vi.fn>;
    const w = world({ language: 'es', translate });

    await w.egress.sendToDevice({ ...queuedNote, card: { ...note, transcript: 'Ring me tonight, Mum. Sarah' } }, DEFAULT_POLICY);

    expect(translate.mock.calls.map(([input]) => (input as { Text: string }).Text)).toEqual([
      'Ring me tonight, Mum. Sarah',
      'Ring me tonight, Mum. <span translate="no">Sarah</span>',
    ]);
    expect(JSON.parse(w.row('CARD#note-1')!.tr_es!.S!)).toEqual({ transcript: 'Llámame esta noche, mamá. Sarah' });
  });

  it('leaves the family the reply she chose in the words Wick offered: the edge reads the stored English', async () => {
    const w = world({ language: 'es' });

    await w.egress.sendToDevice(queuedNote, DEFAULT_POLICY);

    expect(replyText(w.row('CARD#note-1'), 0)).toBe('I will');
    expect(replyText(w.row('CARD#note-1'), 2)).toBe('Thank you');
  });

  it('translates the week’s paragraph, and stores the English one', async () => {
    const w = world({ language: 'es' });

    await w.egress.sendToDevice(queuedWeek, DEFAULT_POLICY);

    expect(JSON.parse(w.row('CARD#week-2026-W41')!.data!.S!).card.text).toBe('A quiet week. Maria came twice.');
    expect(JSON.parse(w.row('CARD#week-2026-W41')!.tr_es!.S!)).toEqual({ text: 'Una semana tranquila. Maria vino dos veces.' });
    const message = w.message();
    expect(message.kind === 'card' && message.card.card).toMatchObject({ text: 'Una semana tranquila. Maria vino dos veces.' });
  });

  it('pushes the English free text, and stores no translation, when the translator fails', async () => {
    const w = world({ language: 'es', translate: broken() });

    await w.egress.sendToDevice(queuedNote, DEFAULT_POLICY);

    expect(w.translate).toHaveBeenCalledTimes(1);
    expect((w.sent[0] as PutItemCommand).input.Item).toEqual(cardItem(queuedNote));
    expect(Object.keys(w.row('CARD#note-1')!).some((name) => name.startsWith('tr_'))).toBe(false);
    const message = w.message();
    // Wick's own sentences are still hers; the note is whole, in the language it was written in.
    expect(message.kind === 'card' && message.card.card).toMatchObject({ transcript: 'Ring me tonight, Mum.' });
    expect(message.kind === 'card' && message.card.card.actions[0]!.label).toBe('[es] I will');
  });

  it('asks no translator for the door’s first card — every word of it is Wick’s own — and writes its row while the language is being read', async () => {
    let release: (language: HouseholdLanguage) => void = () => {};
    const slow = new Promise<HouseholdLanguage>((resolve) => { release = resolve; });
    const w = world({ language: 'es' });
    const egress = deviceEgress({
      table: 'wick',
      db: { send: async (command: unknown) => { w.sent.push(command); return {}; } } as unknown as DeviceEgressDeps['db'],
      push: async (_householdId, payload) => { w.pushed.push({ householdId: 'hh-1', bytes: JSON.stringify(await payload), exceptDeviceId: undefined }); },
      languageOf: () => slow,
      translate: w.translate,
      phrasebook,
      log: () => {},
    });

    const sending = egress.sendToDevice(queuedDoor, DEFAULT_POLICY, { ringDeviceId: 'ava1.ring.device.X' });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // The language is not known yet, and the row is already written: the English card, as ever.
    expect(w.sent).toHaveLength(1);
    expect((w.sent[0] as PutItemCommand).input.Item).toEqual(cardItem(queuedDoor, { ringDeviceId: 'ava1.ring.device.X' }));
    expect(w.pushed).toEqual([]);

    release('es');
    await sending;

    expect(w.translate).not.toHaveBeenCalled();
    const message = w.message();
    expect(message.kind === 'card' && message.card.card).toMatchObject({ line: "[es] Someone's at the front door.", imageRef: door.imageRef });
    expect(message.kind === 'card' && message.card.card.actions.map((action) => action.id)).toEqual(['watch_live', 'dismiss']);
  });
});

describe('a household whose television speaks Spanish — a patch to a card she already has', () => {
  const maria = { personId: 'p1', name: 'Maria', basis: 'schedule' as const, expectedToday: true, confidence: 0.9 };
  const doorWithMaria: QueuedCard = { ...queuedDoor, card: { ...door, match: maria } };

  it('keeps the stored merge English, puts the description’s translation beside it in the same update, and pushes the patch in her language', async () => {
    const w = world({ language: 'es', rows: [stored(doorWithMaria)] });

    await w.egress.sendPatchToDevice({ cardId: 'door-1', description: 'A man holding a parcel.', notice: 'The hallway chime rang.' }, 'hh-1');

    expect(w.sent.map((command) => (command as object).constructor.name)).toEqual(['GetItemCommand', 'UpdateItemCommand']);
    expect((w.sent[1] as UpdateItemCommand).input).toEqual({
      TableName: 'wick',
      Key: { pk: { S: 'HH#hh-1' }, sk: { S: 'CARD#door-1' } },
      UpdateExpression: 'SET #data = :data, #tr = :tr',
      ExpressionAttributeNames: { '#data': 'data', '#tr': 'tr_es' },
      ExpressionAttributeValues: {
        ':data': { S: JSON.stringify({ ...doorWithMaria, card: { ...doorWithMaria.card, description: 'A man holding a parcel.', notice: 'The hallway chime rang.' } }) },
        ':tr': { S: '{"description":"Un hombre con un paquete."}' },
      },
    });
    expect(w.message()).toEqual({
      kind: 'control',
      control: { t: 'patch', patch: { cardId: 'door-1', description: 'Un hombre con un paquete.', notice: '[es] The hallway chime rang.' } },
    });
  });

  it('knows the name the stored card carries, and the one the patch brings: a translation that changed either is asked for again with both marked', async () => {
    const translate = vi.fn(async (input: { Text: string }) => ({
      TranslatedText: input.Text.includes('<span')
        ? '<span translate="no">Maria</span> y <span translate="no">Ana</span> están en la puerta.'
        : 'María y Ana están en la puerta.',
    })) as never as TranslateCall & ReturnType<typeof vi.fn>;
    const w = world({ language: 'es', translate, rows: [stored(doorWithMaria)] });

    await w.egress.sendPatchToDevice({ cardId: 'door-1', description: 'Maria and Ana are at the door.', match: { ...maria, name: 'Ana' } }, 'hh-1');

    expect(translate.mock.calls.map(([input]) => input)).toEqual([
      { Text: 'Maria and Ana are at the door.', SourceLanguageCode: 'en', TargetLanguageCode: 'es', Settings: { Formality: 'FORMAL' } },
      { Text: '<span translate="no">Maria</span> and <span translate="no">Ana</span> are at the door.', SourceLanguageCode: 'en', TargetLanguageCode: 'es', Settings: { Formality: 'FORMAL' } },
    ]);
    const message = w.message();
    expect(message.kind === 'control' && message.control.t === 'patch' && message.control.patch.description).toBe('Maria y Ana están en la puerta.');
  });

  it('keeps what was translated before for the fields the patch does not touch', async () => {
    const w = world({ language: 'es', rows: [stored(queuedDoor, { tr_es: { S: '{"transcript":"Hola."}' } })] });

    await w.egress.sendPatchToDevice({ cardId: 'door-1', description: 'A woman in a red coat.' }, 'hh-1');

    expect(JSON.parse(w.row('CARD#door-1')!.tr_es!.S!)).toEqual({ transcript: 'Hola.', description: 'Una mujer con un abrigo rojo.' });
  });

  it('pushes the English description when the translator fails, and does not leave an older translation standing for a description that has changed', async () => {
    const before = { ...queuedDoor, card: { ...door, description: 'A man holding a parcel.' } };
    const w = world({ language: 'es', translate: broken(), rows: [stored(before, { tr_es: { S: '{"description":"Un hombre con un paquete."}' } })] });

    await w.egress.sendPatchToDevice({ cardId: 'door-1', description: 'A woman in a red coat.' }, 'hh-1');

    expect((w.sent[1] as UpdateItemCommand).input).toMatchObject({
      UpdateExpression: 'SET #data = :data REMOVE #tr',
      ExpressionAttributeNames: { '#data': 'data', '#tr': 'tr_es' },
    });
    const row = w.row('CARD#door-1')!;
    expect(row.tr_es).toBeUndefined();
    expect(JSON.parse(row.data!.S!).card.description).toBe('A woman in a red coat.');
    expect(w.message()).toEqual({ kind: 'control', control: { t: 'patch', patch: { cardId: 'door-1', description: 'A woman in a red coat.' } } });
  });

  it('asks no translator for a patch with no description, and leaves the translations alone', async () => {
    const w = world({ language: 'es', rows: [stored(queuedDoor, { tr_es: { S: '{"description":"Un hombre con un paquete."}' } })] });

    await w.egress.sendPatchToDevice({ cardId: 'door-1', notice: 'The hallway chime rang.' }, 'hh-1');

    expect(w.translate).not.toHaveBeenCalled();
    expect((w.sent[1] as UpdateItemCommand).input.UpdateExpression).toBe('SET #data = :data');
    expect(w.row('CARD#door-1')!.tr_es).toEqual({ S: '{"description":"Un hombre con un paquete."}' });
    expect(w.message()).toEqual({ kind: 'control', control: { t: 'patch', patch: { cardId: 'door-1', notice: '[es] The hallway chime rang.' } } });
  });

  it('does nothing at all for a card that is not stored — and asks no translator about it', async () => {
    const w = world({ language: 'es' });

    await w.egress.sendPatchToDevice({ cardId: 'door-gone', description: 'A man holding a parcel.' }, 'hh-1');

    expect(w.sent.map((command) => (command as object).constructor.name)).toEqual(['GetItemCommand']);
    expect(w.pushed).toEqual([]);
    expect(w.translate).not.toHaveBeenCalled();
  });
});

describe('the home screen is told in her language, and told which it is', () => {
  const look: HomeState = { lookedIn: { name: 'Sarah', at: 5, line: 'Sarah looked in this morning.', until: 9 } };

  it('puts the line through the phrasebook and carries the language with it', async () => {
    const w = world({ language: 'es' });

    await w.egress.sendHomeToDevices('hh-1', look);

    expect(w.message()).toEqual({
      kind: 'control',
      control: { t: 'home', home: { lookedIn: { name: 'Sarah', at: 5, line: '[es] Sarah looked in this morning.', until: 9 }, language: 'es' } },
    });
    expect(w.asked).toEqual(['hh-1']);
  });

  it('reads the language for a home told whole, and says it — that is how the other televisions hear she has just changed it', async () => {
    const w = world({ language: 'es' });

    // What the edge said a moment ago, before it had heard: the row is what counts.
    await w.egress.sendHomeToDevices('hh-1', { light: 'on' }, { whole: true, exceptDeviceId: 'tv-1' });

    expect(w.asked).toEqual(['hh-1']);
    expect(w.pushed[0]!.exceptDeviceId).toBe('tv-1');
    expect(w.message()).toEqual({ kind: 'control', control: { t: 'home', home: { light: 'on', language: 'es' }, whole: true } });
  });

  it('does not go on saying a language she has left', async () => {
    const w = world({ language: 'en' });

    await w.egress.sendHomeToDevices('hh-1', { light: 'on', language: 'es' }, { whole: true });

    expect(w.message()).toEqual({ kind: 'control', control: { t: 'home', home: { light: 'on' }, whole: true } });
  });
});

describe('from the agent plane to the edge and back out — one translation, kept', () => {
  /** The edge's reconcile, for one stored row: what it would put on a television that has just connected. */
  async function replayed(row: Row, language: HouseholdLanguage): Promise<QueuedCard> {
    const sent: QueuedCard[] = [];
    const voice = inHerLanguage({
      sendCard: async (card: QueuedCard) => { sent.push(card); return true; },
      sendControl: async () => true,
      readLanguage: async () => language,
      phrasebook,
      log: () => {},
    });
    expect(isReplayable(row, 10)).toBe(true);
    await voice.sendCard(replayedCard(row), { row });
    return sent[0]!;
  }

  it('a television that connects later is handed the very card the others were pushed, and no translator is asked again', async () => {
    const w = world({ language: 'es' });
    await w.egress.sendToDevice(queuedNote, DEFAULT_POLICY);
    const live = w.message();
    expect(w.translate).toHaveBeenCalledTimes(1);

    const later = await replayed(w.row('CARD#note-1')!, 'es');

    expect(live.kind === 'card' && live.card).toEqual(later);
    expect(later.card).toMatchObject({ transcript: 'Llámame esta noche, mamá.' });
    expect(w.translate).toHaveBeenCalledTimes(1);
  });

  it('a door card described after it was sent is replayed with its description in her language', async () => {
    const w = world({ language: 'es' });
    await w.egress.sendToDevice(queuedDoor, DEFAULT_POLICY);
    await w.egress.sendPatchToDevice({ cardId: 'door-1', description: 'A man holding a parcel.' }, 'hh-1');

    const later = await replayed(w.row('CARD#door-1')!, 'es');

    expect(later.card).toMatchObject({ line: "[es] Someone's at the front door.", description: 'Un hombre con un paquete.' });
    expect(JSON.parse(w.row('CARD#door-1')!.data!.S!).card).toMatchObject({ line: "Someone's at the front door.", description: 'A man holding a parcel.' });
  });

  it('and once she has gone back to English, the same row is replayed as the English card it always held', async () => {
    const w = world({ language: 'es' });
    await w.egress.sendToDevice(queuedNote, DEFAULT_POLICY);

    expect(await replayed(w.row('CARD#note-1')!, 'en')).toEqual(queuedNote);
  });
});
