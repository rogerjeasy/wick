/**
 * A ring handled twice. The door card's id comes from Ring's event id
 * (agents/door/index.ts), so a Lambda retry after a timeout — or a webhook
 * Ring sent again — builds the same card a second time. By then the first
 * may have had its picture and sentence patched in, or been answered, and
 * the second Phase 1 must not put the bare card back over either.
 *
 * The table here honours `attribute_not_exists(sk)` the way DynamoDB does,
 * handing back the stored row on a refusal (ReturnValuesOnConditionCheckFailure).
 */
import { describe, expect, it } from 'vitest';
import { GetItemCommand, PutItemCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { DEFAULT_POLICY } from '@wick/policy';
import type { Card, DeviceWireMessage, DoorCard, HouseholdLanguage, QueuedCard, ReachCard } from '@wick/contracts';
import { deviceEgress, type DeviceEgressDeps } from '../egress.js';

type Row = Record<string, AttributeValue>;

const NOW = 1_790_000_000_000;

const phaseOne: DoorCard = {
  householdId: 'hh-1',
  correlationId: 'corr-1',
  createdAt: NOW,
  type: 'DOOR',
  id: 'door-abc',
  line: "Someone's at the front door.",
  actions: [
    { id: 'watch_live', label: 'Watch live', kind: 'primary' },
    { id: 'dismiss', label: 'Not now', kind: 'dismiss' },
  ],
};
const queued = (at: number): QueuedCard => ({ id: phaseOne.id, urgency: 'DOOR', card: { ...phaseOne, createdAt: at }, queuedAt: at, expiresAt: at + 5 * 60_000, shownCount: 0 });

const keyOf = (key: Row): string => `${key.pk!.S}|${key.sk!.S}`;

function world(language: HouseholdLanguage = 'en') {
  const table = new Map<string, Row>();
  const pushed: DeviceWireMessage[] = [];
  let clock = NOW;

  const send = async (command: unknown): Promise<unknown> => {
    if (command instanceof PutItemCommand) {
      const item = command.input.Item as Row;
      const existing = table.get(keyOf(item));
      if (command.input.ConditionExpression === 'attribute_not_exists(sk)' && existing) {
        throw Object.assign(new Error('The conditional request failed'), {
          name: 'ConditionalCheckFailedException',
          ...(command.input.ReturnValuesOnConditionCheckFailure === 'ALL_OLD' ? { Item: existing } : {}),
        });
      }
      table.set(keyOf(item), item);
      return {};
    }
    if (command instanceof GetItemCommand) return { Item: table.get(keyOf(command.input.Key as Row)) };
    if (command instanceof UpdateItemCommand) {
      // sendPatchToDevice's one shape here: SET #data = :data.
      const key = keyOf(command.input.Key as Row);
      table.set(key, { ...table.get(key)!, data: command.input.ExpressionAttributeValues![':data']! });
      return {};
    }
    throw new Error(`unexpected command ${(command as object).constructor.name}`);
  };

  const phrasebook: DeviceEgressDeps['phrasebook'] = {
    freeTextOf: (card: Card) => (card.type === 'DOOR' && card.description !== undefined ? { description: card.description } : {}),
    cardIn: (lang, card, free = {}) => ({ ...card, ...free, ...(card.type === 'DOOR' ? { line: `[${lang}] ${card.line}` } : {}) }) as Card,
    patchIn: (_lang, patch, free = {}) => ({ ...patch, ...free }),
    homeIn: (_lang, home) => home,
  };

  const egress = deviceEgress({
    table: 'wick',
    db: { send } as unknown as DeviceEgressDeps['db'],
    push: async (_householdId, payload) => void pushed.push((await payload) as DeviceWireMessage),
    languageOf: async () => language,
    translate: (async (input: { Text: string }) => ({ TranslatedText: input.Text })) as never,
    phrasebook,
    log: () => {},
    now: () => clock,
  });

  const stored = (): QueuedCard => JSON.parse(table.get('HH#hh-1|CARD#door-abc')!.data!.S!) as QueuedCard;
  return { egress, table, pushed, stored, later: (ms: number) => void (clock += ms) };
}

const pushedCard = (message: DeviceWireMessage | undefined): QueuedCard => (message as { card: QueuedCard }).card;

describe('a door card is written once', () => {
  it('a second Phase 1 for the same ring leaves the picture and the sentence where they are', async () => {
    const w = world();
    await w.egress.sendToDevice(queued(NOW), DEFAULT_POLICY, { ringDeviceId: 'ava1.ring.device.X' });
    await w.egress.sendPatchToDevice({ cardId: 'door-abc', imageRef: 'https://media.example/frame.jpg' }, 'hh-1');
    await w.egress.sendPatchToDevice({ cardId: 'door-abc', description: 'A man holding a parcel.' }, 'hh-1');

    // The retry, a minute later: the same card id, the bare card, a later queuedAt.
    w.later(60_000);
    await w.egress.sendToDevice(queued(NOW + 60_000), DEFAULT_POLICY, { ringDeviceId: 'ava1.ring.device.X' });

    const card = w.stored().card as DoorCard;
    expect(card.imageRef).toBe('https://media.example/frame.jpg');
    expect(card.description).toBe('A man holding a parcel.');
    expect(w.stored().queuedAt).toBe(NOW);
  });

  it('sends what is stored, picture and all, to a television that may have missed the first push', async () => {
    const w = world();
    await w.egress.sendToDevice(queued(NOW), DEFAULT_POLICY);
    await w.egress.sendPatchToDevice({ cardId: 'door-abc', imageRef: 'https://media.example/frame.jpg' }, 'hh-1');
    w.pushed.length = 0;

    await w.egress.sendToDevice(queued(NOW + 1_000), DEFAULT_POLICY);

    expect(w.pushed).toHaveLength(1);
    expect((pushedCard(w.pushed[0]).card as DoorCard).imageRef).toBe('https://media.example/frame.jpg');
    expect(pushedCard(w.pushed[0]).queuedAt).toBe(NOW);
  });

  it('sends nothing again for a card she has already answered', async () => {
    const w = world();
    await w.egress.sendToDevice(queued(NOW), DEFAULT_POLICY);
    // Her press, as the edge records it (card-acted.mjs).
    w.table.set('HH#hh-1|CARD#door-abc', { ...w.table.get('HH#hh-1|CARD#door-abc')!, actedAt: { N: String(NOW + 5_000) } });
    w.pushed.length = 0;

    await w.egress.sendToDevice(queued(NOW + 10_000), DEFAULT_POLICY);

    expect(w.pushed).toEqual([]);
    expect(w.table.get('HH#hh-1|CARD#door-abc')!.actedAt).toEqual({ N: String(NOW + 5_000) });
  });

  it('sends nothing again once the visitor has gone (the door card\'s own five minutes)', async () => {
    const w = world();
    await w.egress.sendToDevice(queued(NOW), DEFAULT_POLICY);
    w.pushed.length = 0;
    w.later(6 * 60_000);

    await w.egress.sendToDevice(queued(NOW + 6 * 60_000), DEFAULT_POLICY);

    expect(w.pushed).toEqual([]);
  });

  it('sends the stored card again in her language', async () => {
    const w = world('es');
    await w.egress.sendToDevice(queued(NOW), DEFAULT_POLICY);
    w.pushed.length = 0;

    await w.egress.sendToDevice(queued(NOW + 1_000), DEFAULT_POLICY);

    expect((pushedCard(w.pushed[0]).card as DoorCard).line).toBe("[es] Someone's at the front door.");
  });

  it('still lets a card that is meant to change say something new under the same id (Hold for Sarah)', async () => {
    const w = world();
    const reach = (asked: number): QueuedCard => ({
      id: 'reach-r1',
      urgency: 'DEFERRED',
      card: { householdId: 'hh-1', correlationId: 'c', createdAt: NOW, type: 'REACH', id: 'reach-r1', asked } as unknown as ReachCard,
      queuedAt: NOW,
      shownCount: 0,
    });

    await w.egress.sendToDevice(reach(1), DEFAULT_POLICY);
    await w.egress.sendToDevice(reach(2), DEFAULT_POLICY);

    expect((JSON.parse(w.table.get('HH#hh-1|CARD#reach-r1')!.data!.S!) as { card: { asked: number } }).card.asked).toBe(2);
  });

  it('passes on any other failure of the write, so the ring is retried', async () => {
    const w = world();
    const failing = deviceEgress({
      table: 'wick',
      db: { send: async () => { throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }); } } as unknown as DeviceEgressDeps['db'],
      push: async () => {},
      languageOf: async () => 'en',
      translate: (async () => ({})) as never,
      phrasebook: { freeTextOf: () => ({}), cardIn: (_l, c) => c, patchIn: (_l, p) => p, homeIn: (_l, h) => h },
      log: () => {},
    });

    await expect(failing.sendToDevice(queued(NOW), DEFAULT_POLICY)).rejects.toMatchObject({ name: 'ProvisionedThroughputExceededException' });
    expect(w.pushed).toEqual([]);
  });
});
