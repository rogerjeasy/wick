/**
 * The television speaks her language — at the moment she changes it.
 *
 * Seen live: the question went out while the household read as English; her
 * yes changed it at the edge; and for the rest of that minute the sender
 * went on sending English — a card in English under her television's own
 * Spanish words. The sender used to remember a household's language for
 * sixty seconds. It no longer remembers it at all: each send reads it.
 *
 * Here the household's own row is a table in memory, read through the real
 * reader (language/householdLanguage.ts) and the real read
 * (store/household.ts), so what is tested is the path a card takes.
 */
import { describe, expect, it, vi } from 'vitest';
import { GetItemCommand, PutItemCommand, UpdateItemCommand, type AttributeValue, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DEFAULT_POLICY } from '@wick/policy';
import type { Card, CircleCard, DeviceWireMessage, DoorCard, FreeText, HouseholdLanguage, MessageCard, OtherLanguage, QueuedCard } from '@wick/contracts';
import { cardItem, deviceEgress, type DeviceEgressDeps } from '../egress.js';
import { languageReader } from '../language/householdLanguage.js';
import { loadHouseholdLanguage } from '../store/household.js';
// The edge's own replay of a stored card, through its one wrapper on the way out.
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { replayedCard } from '../../../edge-device/lambda/card-acted.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { inHerLanguage } from '../../../edge-device/lambda/language.mjs';

type Row = Record<string, AttributeValue>;

const base = { householdId: 'hh-1', correlationId: 'corr-1', createdAt: 1 };
const circle: CircleCard = {
  ...base,
  type: 'CIRCLE',
  id: 'circle-u2',
  personName: 'Tom',
  role: 'family',
  headline: 'Tom would like to join your family circle.',
  detail: 'If you allow it, Tom can see what you share.',
  actions: [
    { id: 'allow', label: 'Allow', kind: 'primary' },
    { id: 'decline', label: 'Not now', kind: 'secondary' },
  ],
};
const queuedCircle: QueuedCard = { id: circle.id, urgency: 'DEFERRED', card: circle, queuedAt: 5, shownCount: 0 };

const door: DoorCard = { ...base, type: 'DOOR', id: 'door-1', line: "Someone's at the front door.", actions: [{ id: 'dismiss', label: 'Not now', kind: 'dismiss' }] };
const queuedDoor: QueuedCard = { id: 'door-1', urgency: 'DOOR', card: door, queuedAt: 1, expiresAt: 300_000, shownCount: 0 };

const note: MessageCard = { ...base, type: 'MESSAGE', id: 'note-1', fromName: 'Sarah', transcript: 'Ring me tonight, Mum.', suggestedReplies: ['I will'], actions: [{ id: 'reply_0', label: 'I will', kind: 'primary' }] };
const queuedNote: QueuedCard = { id: 'note-1', urgency: 'DEFERRED', card: note, queuedAt: 2, shownCount: 0 };

/** Wick's sentences are marked with the language; free text is replaced only by what is handed in. */
const marked = (language: OtherLanguage, sentence: string): string => `[${language}] ${sentence}`;
const phrasebook: DeviceEgressDeps['phrasebook'] = {
  freeTextOf: (card: Card): FreeText => (card.type === 'MESSAGE' && card.transcript !== undefined ? { transcript: card.transcript } : {}),
  cardIn: (language, card, free = {}) =>
    ({
      ...card,
      ...('headline' in card ? { headline: marked(language, card.headline) } : {}),
      ...(card.type === 'DOOR' ? { line: marked(language, card.line) } : {}),
      ...free,
      actions: card.actions.map((action) => ({ ...action, label: marked(language, action.label) })),
    }) as Card,
  patchIn: (language, patch) => ({ ...patch, ...(patch.notice === undefined ? {} : { notice: marked(language, patch.notice) }) }),
  homeIn: (_language, home) => home,
};

const META = 'HH#hh-1|META';
const keyOf = (key: Row): string => `${key.pk!.S}|${key.sk!.S}`;

/** One household, its row in a table, and a sender wired as the deployed one is — the real reader over the real read. */
function household(language: HouseholdLanguage = 'en') {
  const table = new Map<string, Row>();
  const commands: { readonly name: string; readonly input: Record<string, unknown> }[] = [];
  const pushed: string[] = [];
  const translate = vi.fn(async () => ({ TranslatedText: 'Llámame esta noche, mamá.' }));

  /** What the edge does to the household's row at her press (edge-device language.mjs): English is the absence of a language. */
  const sheSays = (next: HouseholdLanguage) => {
    table.set(META, { pk: { S: 'HH#hh-1' }, sk: { S: 'META' }, ...(next === 'en' ? {} : { language: { S: next } }) });
  };
  sheSays(language);

  const send = async (command: unknown): Promise<unknown> => {
    const { input } = command as { input: Record<string, unknown> };
    commands.push({ name: (command as object).constructor.name, input });
    if (command instanceof GetItemCommand) return { Item: table.get(keyOf(command.input.Key as Row)) };
    if (command instanceof PutItemCommand) {
      table.set(keyOf(command.input.Item as Row), command.input.Item as Row);
      return {};
    }
    if (command instanceof UpdateItemCommand) {
      const key = keyOf(command.input.Key as Row);
      table.set(key, { ...table.get(key)!, data: command.input.ExpressionAttributeValues![':data']! });
      return {};
    }
    throw new Error(`unexpected command ${(command as object).constructor.name}`);
  };
  const db = { send } as unknown as DynamoDBClient;

  const egress = deviceEgress({
    table: 'wick',
    db,
    push: async (_householdId, payload) => { pushed.push(JSON.stringify(await payload)); },
    languageOf: languageReader({ read: (householdId, options) => loadHouseholdLanguage(db, 'wick', householdId, options), log: () => {} }).of,
    translate,
    phrasebook,
    log: () => {},
  });

  const languageReads = () => commands.filter((command) => command.name === 'GetItemCommand' && keyOf(command.input.Key as Row) === META);
  return {
    egress,
    table,
    commands,
    pushed,
    translate,
    sheSays,
    languageReads,
    forget: () => { commands.length = 0; pushed.length = 0; },
    row: (sk: string) => table.get(`HH#hh-1|${sk}`),
    card: (index = 0): Card => {
      const message = JSON.parse(pushed[index]!) as DeviceWireMessage;
      if (message.kind !== 'card') throw new Error('not a card');
      return message.card.card;
    },
  };
}

describe('her yes at t = 0 — a card sent a second later', () => {
  it('is in Spanish: the sender had read "English" a moment before, and does not go by that', async () => {
    vi.useFakeTimers();
    try {
      const home = household('en');
      // The question itself, sent while the household was English — the read the old sender then kept for a minute.
      await home.egress.sendToDevice(queuedDoor, DEFAULT_POLICY);
      expect(home.card(0)).toMatchObject({ line: "Someone's at the front door." });

      home.sheSays('es');
      await vi.advanceTimersByTimeAsync(1000);
      await home.egress.sendToDevice(queuedCircle, DEFAULT_POLICY);

      expect(home.card(1)).toMatchObject({ headline: '[es] Tom would like to join your family circle.' });
      expect((home.card(1) as CircleCard).actions.map((action) => action.label)).toEqual(['[es] Allow', '[es] Not now']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('and so is everything else sent then: a patch, and what the home screen is told', async () => {
    const home = household('en');
    await home.egress.sendToDevice(queuedDoor, DEFAULT_POLICY);
    await home.egress.sendHomeToDevices('hh-1', { light: 'on' });

    home.sheSays('es');
    await home.egress.sendPatchToDevice({ cardId: 'door-1', notice: 'The hallway chime rang.' }, 'hh-1');
    await home.egress.sendHomeToDevices('hh-1', { light: 'on' });

    expect(JSON.parse(home.pushed[1]!)).toEqual({ kind: 'control', control: { t: 'home', home: { light: 'on' } } });
    expect(JSON.parse(home.pushed[2]!)).toEqual({ kind: 'control', control: { t: 'patch', patch: { cardId: 'door-1', notice: '[es] The hallway chime rang.' } } });
    expect(JSON.parse(home.pushed[3]!)).toEqual({ kind: 'control', control: { t: 'home', home: { light: 'on', language: 'es' } } });
  });
});

describe('back to English at t = 0 — a card sent a second later', () => {
  it('is in English, to the byte: the sender had read "Spanish" a moment before, and does not go by that', async () => {
    vi.useFakeTimers();
    try {
      const home = household('es');
      await home.egress.sendToDevice(queuedDoor, DEFAULT_POLICY);
      expect(home.card(0)).toMatchObject({ line: "[es] Someone's at the front door." });

      home.sheSays('en');
      await vi.advanceTimersByTimeAsync(1000);
      await home.egress.sendToDevice(queuedCircle, DEFAULT_POLICY);

      expect(home.pushed[1]).toBe(JSON.stringify({ kind: 'card', card: queuedCircle }));
      expect(home.pushed[1]).toBe(
        '{"kind":"card","card":{"id":"circle-u2","urgency":"DEFERRED","card":{"householdId":"hh-1","correlationId":"corr-1","createdAt":1,"type":"CIRCLE","id":"circle-u2","personName":"Tom","role":"family","headline":"Tom would like to join your family circle.","detail":"If you allow it, Tom can see what you share.","actions":[{"id":"allow","label":"Allow","kind":"primary"},{"id":"decline","label":"Not now","kind":"secondary"}]},"queuedAt":5,"shownCount":0}}',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what a send costs: one read of one attribute, each time', () => {
  const consistentReadOfTheLanguage = {
    TableName: 'wick',
    Key: { pk: { S: 'HH#hh-1' }, sk: { S: 'META' } },
    ProjectionExpression: '#language',
    ExpressionAttributeNames: { '#language': 'language' },
    ConsistentRead: true,
  };

  it('a card: one — and as it is so this instant, not as a replica last heard', async () => {
    const home = household('en');

    await home.egress.sendToDevice(queuedCircle, DEFAULT_POLICY);

    expect(home.languageReads().map((command) => command.input)).toEqual([consistentReadOfTheLanguage]);
  });

  it('every card: one each, however soon after the last', async () => {
    const home = household('es');

    await home.egress.sendToDevice(queuedCircle, DEFAULT_POLICY);
    await home.egress.sendToDevice(queuedDoor, DEFAULT_POLICY);
    await home.egress.sendToDevice(queuedNote, DEFAULT_POLICY);

    expect(home.languageReads()).toHaveLength(3);
  });

  it('a patch: one, made beside the read of the card it already makes', async () => {
    const home = household('en');
    await home.egress.sendToDevice(queuedDoor, DEFAULT_POLICY);
    home.forget();

    await home.egress.sendPatchToDevice({ cardId: 'door-1', notice: 'The hallway chime rang.' }, 'hh-1');

    expect(home.languageReads()).toHaveLength(1);
    expect(home.commands.map((command) => command.name)).toEqual(['GetItemCommand', 'GetItemCommand', 'UpdateItemCommand']);
  });

  it('what the home screen is told: one, whole or in part', async () => {
    const home = household('en');

    await home.egress.sendHomeToDevices('hh-1', { light: 'on' });
    await home.egress.sendHomeToDevices('hh-1', { light: 'on' }, { whole: true });

    expect(home.languageReads().map((command) => command.input)).toEqual([consistentReadOfTheLanguage, consistentReadOfTheLanguage]);
  });

  it('a card and its patch sent in the same tick: one between them', async () => {
    const home = household('en');
    await home.egress.sendToDevice(queuedDoor, DEFAULT_POLICY);
    home.forget();

    await Promise.all([home.egress.sendToDevice(queuedCircle, DEFAULT_POLICY), home.egress.sendPatchToDevice({ cardId: 'door-1', notice: 'x' }, 'hh-1')]);

    expect(home.languageReads()).toHaveLength(1);
  });

  it('the door’s first card: its read is made while its row is being written, not before — the headline does not wait for it', async () => {
    // A table whose answer about the language does not come until the card's row has been asked for:
    // a sender that waited for the language before writing would never get here.
    let rowAskedFor: () => void = () => {};
    const written = new Promise<void>((resolve) => { rowAskedFor = resolve; });
    const order: string[] = [];
    const db = {
      send: async (command: unknown) => {
        if (command instanceof PutItemCommand) {
          order.push('row asked for');
          rowAskedFor();
          return {};
        }
        if (command instanceof GetItemCommand) {
          order.push('language asked for');
          await written;
          order.push('language answered');
          return { Item: { language: { S: 'es' } } };
        }
        throw new Error('unexpected');
      },
    } as unknown as DynamoDBClient;
    const pushed: string[] = [];
    const egress = deviceEgress({
      table: 'wick',
      db,
      push: async (_householdId, payload) => { pushed.push(JSON.stringify(await payload)); },
      languageOf: languageReader({ read: (householdId, options) => loadHouseholdLanguage(db, 'wick', householdId, options), log: () => {} }).of,
      translate: vi.fn(),
      phrasebook,
      log: () => {},
    });

    await egress.sendToDevice(queuedDoor, DEFAULT_POLICY);

    expect(order).toEqual(['language asked for', 'row asked for', 'language answered']);
    expect(JSON.parse(pushed[0]!).card.card.line).toBe("[es] Someone's at the front door.");
  }, 2000);

  it('a household that cannot be read is sent English, and the card still goes', async () => {
    const home = household('es');
    const failing = deviceEgress({
      table: 'wick',
      db: { send: async (command: unknown) => { if (command instanceof GetItemCommand) throw Object.assign(new Error('no'), { name: 'ProvisionedThroughputExceededException' }); return {}; } } as unknown as DeviceEgressDeps['db'],
      push: async (_householdId, payload) => { home.pushed.push(JSON.stringify(await payload)); },
      languageOf: languageReader({ read: async () => { throw Object.assign(new Error('no'), { name: 'ProvisionedThroughputExceededException' }); }, log: () => {} }).of,
      translate: home.translate,
      phrasebook,
      log: () => {},
    });

    await failing.sendToDevice(queuedCircle, DEFAULT_POLICY);

    expect(home.pushed).toEqual([JSON.stringify({ kind: 'card', card: queuedCircle })]);
  });
});

describe('a send that straddles her answer — nothing stale is stored, so the next asking puts it right', () => {
  /**
   * The read and the push are two steps: a card whose language was read an
   * instant before her yes still arrives in the old one. That cannot be
   * closed inside one send. What closes it: her television asks for its
   * cards again when its language changes, and the edge replays the stored
   * card through its own wrapper, with the language as it is then.
   */
  const storedBy = async (language: HouseholdLanguage, queued: QueuedCard) => {
    const home = household(language);
    await home.egress.sendToDevice(queued, DEFAULT_POLICY);
    return home.row(`CARD#${queued.id}`)!;
  };

  /** The edge's reconcile, for one stored row, in the language the household has by then. */
  async function replayed(row: Row, language: HouseholdLanguage): Promise<QueuedCard> {
    const sent: QueuedCard[] = [];
    const voice = inHerLanguage({
      sendCard: async (card: QueuedCard) => { sent.push(card); return true; },
      sendControl: async () => true,
      readLanguage: async () => language,
      phrasebook,
      log: () => {},
    });
    await voice.sendCard(replayedCard(row), { row });
    return sent[0]!;
  }

  it('a card of Wick’s own words is stored as the very same row, whichever language was read', async () => {
    for (const queued of [queuedCircle, queuedDoor]) {
      const whenEnglish = await storedBy('en', queued);
      const whenSpanish = await storedBy('es', queued);

      expect(whenSpanish).toEqual(whenEnglish);
      expect(whenEnglish).toEqual(cardItem(queued));
    }
  });

  it('a note’s stored card is the same English too; only the translation kept beside it depends on what was read', async () => {
    const whenEnglish = await storedBy('en', queuedNote);
    const whenSpanish = await storedBy('es', queuedNote);

    expect(whenSpanish.data).toEqual(whenEnglish.data);
    expect(JSON.parse(whenEnglish.data!.S!)).toEqual(queuedNote);
    const { tr_es: kept, ...rest } = whenSpanish;
    expect(rest).toEqual(whenEnglish);
    expect(JSON.parse(kept!.S!)).toEqual({ transcript: 'Llámame esta noche, mamá.' });
    // Read as English: no translator was asked, and nothing is kept beside the card.
    expect(Object.keys(whenEnglish).some((name) => name.startsWith('tr_'))).toBe(false);
  });

  it('a card stored an instant before her yes is replayed in Spanish when her television asks again', async () => {
    const row = await storedBy('en', queuedCircle);

    const again = await replayed(row, 'es');

    expect(again.card).toMatchObject({ headline: '[es] Tom would like to join your family circle.' });
  });

  it('a note stored an instant before her yes is replayed with Wick’s words in Spanish and its own text as it was written: the edge never asks a translator', async () => {
    const row = await storedBy('en', queuedNote);

    const again = await replayed(row, 'es');

    expect(again.card).toMatchObject({ transcript: 'Ring me tonight, Mum.' });
    expect(again.card.actions.map((action) => action.label)).toEqual(['[es] I will']);
  });

  it('and one stored an instant before she went back to English is replayed as the English card it always held', async () => {
    expect(await replayed(await storedBy('es', queuedNote), 'en')).toEqual(queuedNote);
    expect(await replayed(await storedBy('es', queuedCircle), 'en')).toEqual(queuedCircle);
  });
});
