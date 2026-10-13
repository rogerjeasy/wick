/**
 * The mantelpiece — a picture's address on the way out of egress.ts
 * (packages/contracts mantel.ts): minted for what is pushed, and in nothing
 * that is written.
 *
 * The table, the push and the signer are stand-ins handed to `deviceEgress`.
 */
import { describe, expect, it, vi } from 'vitest';
import { GetItemCommand, PutItemCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { DEFAULT_POLICY } from '@wick/policy';
import { MANTEL_URL_TTL_SEC, photoCardId, photoCardWords, photoObjectKey, type Card, type DeviceWireMessage, type HouseholdLanguage, type MessageCard, type PhotoCard, type QueuedCard } from '@wick/contracts';
import { cardItem, deviceEgress, pictureRequest, type DeviceEgressDeps } from '../egress.js';
// The edge's own replay of a stored card, and its one wrapper on the way out.
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { replayedCard } from '../../../edge-device/lambda/card-acted.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { inHerLanguage } from '../../../edge-device/lambda/language.mjs';

type Row = Record<string, AttributeValue>;

const base = { householdId: 'hh-1', correlationId: 'corr-1', createdAt: 1 };
const photo: PhotoCard = { ...base, type: 'PHOTO', id: photoCardId('p1'), photoId: 'p1', fromName: 'Sarah', ...photoCardWords('Sarah') };
const queuedPhoto: QueuedCard = { id: photo.id, urgency: 'DEFERRED', card: photo, queuedAt: 5, shownCount: 0 };

const note: MessageCard = { ...base, type: 'MESSAGE', id: 'note-1', fromName: 'Sarah', transcript: 'Ring me tonight, Mum.', suggestedReplies: ['I will'], actions: [{ id: 'reply_0', label: 'I will', kind: 'primary' }] };
const queuedNote: QueuedCard = { id: 'note-1', urgency: 'DEFERRED', card: note, queuedAt: 2, shownCount: 0 };

const ADDRESS = 'https://wick-photos.s3.us-east-1.amazonaws.com/photos/hh-1/p1.jpg?X-Amz-Signature=abc';

/** A phrasebook that marks Wick's sentences, so that what went through it can be told. */
const phrasebook: DeviceEgressDeps['phrasebook'] = {
  freeTextOf: (card: Card) => (card.type === 'MESSAGE' && card.transcript !== undefined ? { transcript: card.transcript } : {}),
  cardIn: (language, card) => ({ ...card, ...('headline' in card ? { headline: `[${language}] ${card.headline}` } : {}) }) as Card,
  patchIn: (_language, patch) => patch,
  homeIn: (_language, home) => home,
};

const keyOf = (key: Row): string => `${key.pk!.S}|${key.sk!.S}`;

function world(options: { readonly language?: HouseholdLanguage; readonly pictureAddress?: DeviceEgressDeps['pictureAddress']; readonly without?: 'signer' } = {}) {
  const table = new Map<string, Row>();
  const sent: unknown[] = [];
  const pushed: string[] = [];
  const said: string[] = [];
  const pictureAddress = vi.fn(options.pictureAddress ?? (async () => ADDRESS));

  const send = async (command: unknown): Promise<unknown> => {
    sent.push(command);
    if (command instanceof PutItemCommand) {
      table.set(keyOf(command.input.Item as Row), command.input.Item as Row);
      return {};
    }
    if (command instanceof GetItemCommand) return { Item: table.get(keyOf(command.input.Key as Row)) };
    if (command instanceof UpdateItemCommand) {
      const key = keyOf(command.input.Key as Row);
      table.set(key, { ...table.get(key)!, data: command.input.ExpressionAttributeValues![':data']! });
      return {};
    }
    throw new Error(`unexpected command ${(command as object).constructor.name}`);
  };

  const egress = deviceEgress({
    table: 'wick',
    db: { send } as unknown as DeviceEgressDeps['db'],
    push: async (_householdId, payload) => { pushed.push(JSON.stringify(await payload)); },
    languageOf: async () => options.language ?? 'en',
    translate: vi.fn(async () => ({ TranslatedText: 'Llámame esta noche, mamá.' })),
    phrasebook,
    ...(options.without === 'signer' ? {} : { pictureAddress }),
    log: (line) => said.push(JSON.stringify(line)),
  });

  return {
    egress,
    table,
    sent,
    pushed,
    said,
    pictureAddress,
    row: (sk: string): Row | undefined => table.get(`HH#hh-1|${sk}`),
    message: (index = 0): DeviceWireMessage => JSON.parse(pushed[index]!) as DeviceWireMessage,
    everythingWritten: (): string => JSON.stringify([...table.values()]),
  };
}

const STORED_PHOTO =
  '{"id":"photo-p1","urgency":"DEFERRED","card":{"householdId":"hh-1","correlationId":"corr-1","createdAt":1,"type":"PHOTO","id":"photo-p1","photoId":"p1","fromName":"Sarah","headline":"A picture from Sarah.","actions":[{"id":"keep","label":"Keep it","kind":"primary"},{"id":"thanks","label":"Thank you","kind":"secondary"}]},"queuedAt":5,"shownCount":0}';

describe('a picture’s card on its way to her television', () => {
  it('is pushed with an address minted for this household’s own picture, and stored without one', async () => {
    const w = world();

    await w.egress.sendToDevice(queuedPhoto, DEFAULT_POLICY);

    expect(w.pictureAddress.mock.calls).toEqual([['hh-1', 'p1']]);
    const message = w.message();
    expect(message.kind === 'card' && message.card).toEqual({ ...queuedPhoto, card: { ...photo, photoUrl: ADDRESS } });

    // The row: the card as it was written, to the byte — the picture's id, and nothing else of it.
    expect(w.sent.map((command) => (command as object).constructor.name)).toEqual(['PutItemCommand']);
    expect((w.sent[0] as PutItemCommand).input).toEqual({ TableName: 'wick', Item: { pk: { S: 'HH#hh-1' }, sk: { S: 'CARD#photo-p1' }, data: { S: STORED_PHOTO } } });
    expect(w.everythingWritten()).not.toMatch(/photoUrl|X-Amz|amazonaws/);
  });

  it('never stores, and never passes on, an address that came with the card: only one minted here is sent', async () => {
    const w = world();
    const carrying: QueuedCard = { ...queuedPhoto, card: { ...photo, photoUrl: 'https://stale.example/old?X-Amz-Signature=old' } };

    await w.egress.sendToDevice(carrying, DEFAULT_POLICY);

    expect(w.row('CARD#photo-p1')!.data!.S).toBe(STORED_PHOTO);
    const message = w.message();
    expect(message.kind === 'card' && message.card.card).toMatchObject({ photoUrl: ADDRESS });
    expect(w.pushed[0]).not.toContain('stale.example');
  });

  it('still goes, without an address, when none can be minted — and says why without saying which picture', async () => {
    const failing = world({ pictureAddress: async () => { throw Object.assign(new Error('for p1 of hh-1'), { name: 'CredentialsProviderError' }); } });
    await failing.egress.sendToDevice(queuedPhoto, DEFAULT_POLICY);
    expect(failing.pushed).toEqual([JSON.stringify({ kind: 'card', card: queuedPhoto })]);
    expect(failing.said.map((line) => JSON.parse(line))).toEqual([{ level: 'error', msg: 'picture_address_failed', reason: 'CredentialsProviderError' }]);
    expect(failing.row('CARD#photo-p1')!.data!.S).toBe(STORED_PHOTO);

    const none = world({ pictureAddress: async () => undefined });
    await none.egress.sendToDevice(queuedPhoto, DEFAULT_POLICY);
    expect(none.pushed).toEqual([JSON.stringify({ kind: 'card', card: queuedPhoto })]);

    const unsigned = world({ without: 'signer' });
    await unsigned.egress.sendToDevice({ ...queuedPhoto, card: { ...photo, photoUrl: 'https://stale.example/old' } }, DEFAULT_POLICY);
    expect(unsigned.pushed).toEqual([JSON.stringify({ kind: 'card', card: queuedPhoto })]);
  });

  it('goes through the phrasebook first in a household that is not English, and is given its address after', async () => {
    const w = world({ language: 'es' });

    await w.egress.sendToDevice(queuedPhoto, DEFAULT_POLICY);

    const message = w.message();
    expect(message.kind === 'card' && message.card.card).toEqual({ ...photo, headline: '[es] A picture from Sarah.', photoUrl: ADDRESS });
    expect(w.row('CARD#photo-p1')!.data!.S).toBe(STORED_PHOTO);
  });

  it('says nothing aloud of an address it minted', async () => {
    const w = world();

    await w.egress.sendToDevice(queuedPhoto, DEFAULT_POLICY);

    expect(w.said).toEqual([]);
  });

  it('keeps the row free of any address through a patch as well', async () => {
    const w = world();
    await w.egress.sendToDevice(queuedPhoto, DEFAULT_POLICY);

    await w.egress.sendPatchToDevice({ cardId: 'photo-p1', notice: 'x' }, 'hh-1');

    expect(w.row('CARD#photo-p1')!.data!.S).toBe(STORED_PHOTO);
    expect(w.pushed[1]).toBe('{"kind":"control","control":{"t":"patch","patch":{"cardId":"photo-p1","notice":"x"}}}');
    expect(w.everythingWritten()).not.toMatch(/photoUrl|X-Amz/);
  });
});

describe('every other card is exactly what it was', () => {
  it('asks for no address, and is stored and pushed to the byte as before', async () => {
    const w = world();

    await w.egress.sendToDevice(queuedNote, DEFAULT_POLICY);

    expect(w.pictureAddress).not.toHaveBeenCalled();
    expect((w.sent[0] as PutItemCommand).input).toEqual({ TableName: 'wick', Item: cardItem(queuedNote) });
    expect(w.pushed).toEqual([JSON.stringify({ kind: 'card', card: queuedNote })]);
    expect(w.pushed[0]).toBe(
      '{"kind":"card","card":{"id":"note-1","urgency":"DEFERRED","card":{"householdId":"hh-1","correlationId":"corr-1","createdAt":1,"type":"MESSAGE","id":"note-1","fromName":"Sarah","transcript":"Ring me tonight, Mum.","suggestedReplies":["I will"],"actions":[{"id":"reply_0","label":"I will","kind":"primary"}]},"queuedAt":2,"shownCount":0}}',
    );
  });
});

describe('pictureRequest — what is signed', () => {
  it('is a GET of the picture’s own object in the pictures’ bucket, good for an hour', () => {
    expect(pictureRequest({ bucket: 'wick-photos-1', householdId: 'hh-1', photoId: 'p1' })).toEqual({
      Bucket: 'wick-photos-1',
      Key: photoObjectKey('hh-1', 'p1'),
      expiresIn: MANTEL_URL_TTL_SEC,
    });
    expect(MANTEL_URL_TTL_SEC).toBe(3600);
  });

  it('is nothing without a bucket, or for an id that is not a picture’s: nothing in a card can name another object', () => {
    expect(pictureRequest({ bucket: undefined, householdId: 'hh-1', photoId: 'p1' })).toBeUndefined();
    expect(pictureRequest({ bucket: '', householdId: 'hh-1', photoId: 'p1' })).toBeUndefined();
    for (const photoId of ['../../snapshots/x', 'a/b', '', 'p1.jpg']) expect(pictureRequest({ bucket: 'b', householdId: 'hh-1', photoId })).toBeUndefined();
  });
});

describe('from the agent plane to the edge and back out — an address each time, and none kept', () => {
  it('a television that connects later is handed the same card with an address of its own', async () => {
    const w = world();
    await w.egress.sendToDevice(queuedPhoto, DEFAULT_POLICY);
    const row = w.row('CARD#photo-p1')!;

    const later: QueuedCard[] = [];
    const voice = inHerLanguage({
      sendCard: async (card: QueuedCard) => { later.push(card); return true; },
      sendControl: async () => true,
      readLanguage: async () => 'en',
      phrasebook,
      pictureAddress: (photoId: string) => `https://edge.example/${photoId}?X-Amz-Signature=later`,
      log: () => {},
    });
    await voice.sendCard(replayedCard(row), { row });

    expect(later).toEqual([{ ...queuedPhoto, card: { ...photo, photoUrl: 'https://edge.example/p1?X-Amz-Signature=later' } }]);
    expect(row.data!.S).toBe(STORED_PHOTO);
  });
});
