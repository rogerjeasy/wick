import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { MAX_PHOTOS_A_DAY, isPhotoId, photoCardWords, type QueuedCard } from '@wick/contracts';
import { createMemoryStore } from '../../accounts/__tests__/memoryStore.js';
import type { Membership } from '../../accounts/types.js';
import { createMemoryTable } from '../../__tests__/memoryTable.js';
import type { ModerationVerdict } from '../moderation.js';
import { createS3PhotoObjects } from '../objects.js';
import { loadSentPictures } from '../pictures.js';
import { PHOTO_TTL_MS } from '../rows.js';
import { PhotoRefusal, sendPhoto, type PhotoDeps } from '../send.js';
import { createMemoryObjects } from './memoryObjects.js';

// Monday 21 September 2026, 15:13 where the house is (Europe/London).
const NOW = 1_790_000_000_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const HH = 'hh_1';
const SARAH = { householdId: HH, userId: 'u_sarah' };
const TOM = { householdId: HH, userId: 'u_tom' };

/** Bytes that are a JPEG by their markers and nothing else: made here, never a photograph. */
const jpeg = (length = 64, fill = 7): Uint8Array => {
  const bytes = new Uint8Array(length).fill(fill);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.set([0xff, 0xd9], length - 2);
  return bytes;
};

type Item = Record<string, AttributeValue>;
interface TableRequest {
  readonly command: string;
  readonly pk: string;
  /** The sort key asked for, or the prefix or range a query asks for. */
  readonly sk: string;
}

const member = (over: Partial<Membership> = {}): Membership => ({
  householdId: HH,
  userId: 'u_sarah',
  name: 'Sarah Bennett',
  role: 'organiser',
  status: 'allowed',
  requestedAt: 1,
  ...over,
});

async function setup(options: { television?: boolean; timeZone?: string } = {}) {
  const table = createMemoryTable();
  const requests: TableRequest[] = [];
  const events: string[] = [];
  const before: ((request: TableRequest) => void)[] = [];
  const ddb = {
    send: async (command: { constructor: { name: string }; input: { Key?: Item; Item?: Item; ExpressionAttributeValues?: Item } }) => {
      const { input } = command;
      const request: TableRequest = {
        command: command.constructor.name,
        pk: input.Key?.pk?.S ?? input.Item?.pk?.S ?? input.ExpressionAttributeValues?.[':pk']?.S ?? '',
        sk: input.Key?.sk?.S ?? input.Item?.sk?.S ?? input.ExpressionAttributeValues?.[':prefix']?.S ?? input.ExpressionAttributeValues?.[':from']?.S ?? '',
      };
      for (const hook of before.splice(0)) hook(request);
      requests.push(request);
      events.push(`${request.command} ${request.sk}`);
      return (table.ddb as unknown as { send: (c: unknown) => Promise<unknown> }).send(command);
    },
  } as unknown as DynamoDBClient;

  const store = createMemoryStore(() => NOW);
  await store.createHousehold({ householdId: HH, name: 'Mum’s house', residentName: 'Margaret', createdBy: 'u_sarah', createdAt: 1 });
  await store.putMembership(member());
  await store.putMembership(member({ userId: 'u_tom', name: 'Tom', role: 'family' }));
  await store.createHousehold({ householdId: 'hh_2', name: 'Edith’s home', residentName: 'Edith', createdBy: 'u_priya', createdAt: 1 });
  await store.putMembership(member({ householdId: 'hh_2', userId: 'u_priya', name: 'Priya' }));
  if (options.television !== false) store.addTelevision(HH, { deviceId: 'tv-1', pairedAt: 5, connected: true });
  store.addTelevision('hh_2', { deviceId: 'tv-2', pairedAt: 5, connected: true });

  const bucket = createMemoryObjects();
  const cards: QueuedCard[] = [];
  const withdrawn: { householdId: string; cardId: string }[] = [];
  const looked: Uint8Array[] = [];
  const world = { clock: NOW, verdict: 'pass' as ModerationVerdict, sendFails: false, ids: 0 };
  const deps: PhotoDeps = {
    ddb,
    store,
    objects: createS3PhotoObjects(async (command) => {
      events.push(command.constructor.name);
      return bucket.send(command);
    }, 'wick-photos-test'),
    moderate: async (bytes) => {
      events.push('moderate');
      looked.push(bytes);
      return world.verdict;
    },
    sendCard: async (card) => {
      if (world.sendFails) throw new Error('egress is down');
      events.push(`card ${card.id}`);
      cards.push(card);
    },
    withdrawCard: async (householdId, cardId) => void withdrawn.push({ householdId, cardId }),
    now: () => world.clock,
    newId: () => `made${++world.ids}`,
    timeZone: options.timeZone ?? 'Europe/London',
  };

  const rows = (householdId = HH): Item[] => table.rows(`HH#${householdId}`);
  const photoRows = (householdId = HH): Item[] => rows(householdId).filter((row) => row.sk?.S?.startsWith('PHOTO#'));
  /**
   * What her press on the PHOTO card does (the edge, written elsewhere):
   * either button marks the picture seen; "Keep it" also puts it on her
   * mantelpiece. Taking one down later removes it from there.
   */
  const residentPresses = (photoId: string, action: 'keep' | 'thanks'): void => {
    const row = photoRows().find((held) => held.sk?.S === `PHOTO#${photoId}`)!;
    table.put({ ...row, seenAt: { N: String(world.clock) } });
    if (action === 'keep') table.put({ pk: { S: `HH#${HH}` }, sk: { S: `MANTEL#${photoId}` }, photoId: { S: photoId }, keptAt: { N: String(world.clock) } });
  };
  const residentTakesDown = (photoId: string): void => {
    // The memory table has no delete of its own to call from a test: put it away through the client, unrecorded.
    void (table.ddb as unknown as { send: (c: unknown) => Promise<unknown> }).send({
      constructor: { name: 'DeleteItemCommand' },
      input: { Key: { pk: { S: `HH#${HH}` }, sk: { S: `MANTEL#${photoId}` } } },
    });
  };

  return { deps, store, table, bucket, cards, withdrawn, looked, world, requests, events, rows, photoRows, residentPresses, residentTakesDown, beforeNext: (hook: (request: TableRequest) => void) => void before.push(hook) };
}

const refusal = async (attempt: Promise<unknown>): Promise<PhotoRefusal> => {
  const err: unknown = await attempt.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(err).toBeInstanceOf(PhotoRefusal);
  return err as PhotoRefusal;
};

/**
 * Nothing was stored, written or sent. `tried`: how many times a picture got
 * as far as being looked at — each of those is counted (photos/tries.ts),
 * and that count is the one thing a refused picture leaves behind.
 */
function expectNothingDone(w: Awaited<ReturnType<typeof setup>>, tried = 0): void {
  expect(w.bucket.sent).toEqual([]);
  expect(w.photoRows()).toEqual([]);
  expect(w.cards).toEqual([]);
  const writes = w.requests.filter((request) => request.command !== 'GetItemCommand' && request.command !== 'QueryCommand');
  expect(writes.map((request) => request.command)).toEqual(Array.from({ length: tried }, () => 'UpdateItemCommand'));
  expect(writes.every((request) => request.sk.startsWith('TRY#PHOTO#'))).toBe(true);
}

describe('sendPhoto — a picture for her television', () => {
  it('claims the picture’s row, stores the picture, and puts one card on her television — in that order', async () => {
    const w = await setup();
    const bytes = jpeg(2000);

    const answer = await sendPhoto(w.deps, SARAH, bytes, undefined);

    expect(answer).toEqual({
      sent: true,
      photoId: 'made1',
      say: 'Your picture is on its way to Margaret’s television. It will wait for a quiet moment.',
    });
    // The row is the claim on the id; the picture is stored before the card that shows it is sent.
    expect(w.events.filter((event) => !event.startsWith('GetItem') && !event.startsWith('Query'))).toEqual([
      // The try is counted before anything looks at the picture.
      'UpdateItemCommand TRY#PHOTO#u_sarah#2026-09-21',
      'moderate',
      'PutItemCommand PHOTO#made1',
      'PutObjectCommand',
      'card photo-made1',
    ]);

    expect(w.bucket.objects.get('photos/hh_1/made1.jpg')).toEqual({ bytes, contentType: 'image/jpeg', tagging: 'state=sent' });
    expect(w.photoRows()).toEqual([
      {
        pk: { S: 'HH#hh_1' },
        sk: { S: 'PHOTO#made1' },
        photoId: { S: 'made1' },
        sentBy: { S: 'u_sarah' },
        sentByName: { S: 'Sarah Bennett' },
        sentAt: { N: String(NOW) },
        // About thirteen months: long enough to say it was seen, not for ever.
        ttl: { N: String(Math.floor((NOW + PHOTO_TTL_MS) / 1000)) },
      },
    ]);
    expect(PHOTO_TTL_MS).toBe(396 * DAY);
    expect(w.cards).toEqual([
      {
        id: 'photo-made1',
        urgency: 'DEFERRED',
        queuedAt: NOW,
        shownCount: 0,
        card: {
          type: 'PHOTO',
          id: 'photo-made1',
          householdId: HH,
          correlationId: 'photo-made1',
          createdAt: NOW,
          photoId: 'made1',
          fromName: 'Sarah Bennett',
          ...photoCardWords('Sarah Bennett'),
        },
      },
    ]);
    expect(w.cards[0]!.card).toMatchObject({ headline: 'A picture from Sarah.' });
    expect(w.cards[0]!.card.actions.map((action) => action.id)).toEqual(['keep', 'thanks']);
  });

  it('puts no address anywhere it writes: the card and the row carry the picture’s id, and nothing that finds its bytes', async () => {
    const w = await setup();

    await sendPhoto(w.deps, SARAH, jpeg(), undefined);

    const written = JSON.stringify([w.cards, w.photoRows()]);
    expect(written).not.toMatch(/https?:|s3:|amazonaws|wick-photos-test|photos\/|\.jpg|photoUrl|X-Amz/i);
    expect(w.cards[0]!.card).not.toHaveProperty('photoUrl');
  });

  it('makes an id that is a picture’s id, and a new one each time', async () => {
    const w = await setup();

    const first = await sendPhoto(w.deps, SARAH, jpeg(), undefined);
    const second = await sendPhoto(w.deps, SARAH, jpeg(), undefined);

    expect(isPhotoId(first.photoId)).toBe(true);
    expect(second.photoId).not.toBe(first.photoId);
  });

  it('is for a family member she allows as it is for the organiser, under their own name', async () => {
    const w = await setup();

    await sendPhoto(w.deps, TOM, jpeg(), undefined);

    expect(w.cards[0]!.card).toMatchObject({ fromName: 'Tom', headline: 'A picture from Tom.' });
    expect(w.photoRows()[0]).toMatchObject({ sentBy: { S: 'u_tom' }, sentByName: { S: 'Tom' } });
  });

  it('INV-8: stores, writes and sends only in the sender’s own household', async () => {
    const w = await setup();

    await sendPhoto(w.deps, { householdId: 'hh_2', userId: 'u_priya' }, jpeg(), undefined);

    expect([...w.bucket.objects.keys()]).toEqual(['photos/hh_2/made1.jpg']);
    expect(w.photoRows('hh_2')).toHaveLength(1);
    expect(w.photoRows(HH)).toEqual([]);
    expect(w.cards.map((card) => card.card.householdId)).toEqual(['hh_2']);
    expect(w.requests.every((request) => request.pk === 'HH#hh_2')).toBe(true);
  });
});

describe('sendPhoto — who may send', () => {
  it.each([
    ['pending', 'Margaret hasn’t allowed this yet. A card is waiting on the television, and it only takes one press.'],
    ['declined', 'Margaret chose not to share this with you.'],
    ['removed', 'You are no longer part of this family circle.'],
  ] as const)('INV-9: refuses somebody who is %s — the organiser too — and does nothing', async (status, message) => {
    for (const who of [SARAH, TOM]) {
      const w = await setup();
      await w.store.setMemberStatus(HH, who.userId, status, NOW);

      const refused = await refusal(sendPhoto(w.deps, who, jpeg(), undefined));

      expect(refused).toMatchObject({ status: 403, code: 'not_allowed_yet', message });
      expectNothingDone(w);
      expect(w.looked).toEqual([]);
    }
  });

  it('refuses a neighbour, allowed or not: a picture is for the family to send', async () => {
    for (const status of ['allowed', 'pending'] as const) {
      const w = await setup();
      await w.store.putMembership(member({ userId: 'u_june', name: 'June', role: 'neighbour', status }));

      const refused = await refusal(sendPhoto(w.deps, { householdId: HH, userId: 'u_june' }, jpeg(), undefined));

      expect(refused).toMatchObject({ status: 403, code: 'not_for_a_neighbour', message: 'A neighbour cannot send a picture.' });
      expectNothingDone(w);
    }
  });

  it('refuses somebody who is in no circle here', async () => {
    const w = await setup();

    expect(await refusal(sendPhoto(w.deps, { householdId: HH, userId: 'u_priya' }, jpeg(), undefined))).toMatchObject({ status: 403, message: 'You are not part of this family circle.' });
    expectNothingDone(w);
  });

  it('INV-9: asks again on every call — allowed for the first picture, removed before the second', async () => {
    const w = await setup();
    await sendPhoto(w.deps, TOM, jpeg(), undefined);
    await w.store.setMemberStatus(HH, 'u_tom', 'removed', NOW);

    await refusal(sendPhoto(w.deps, TOM, jpeg(), undefined));

    expect(w.cards).toHaveLength(1);
  });
});

describe('sendPhoto — what is refused, and what refusing does', () => {
  it.each([
    ['nothing at all', new Uint8Array()],
    ['a PNG', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])],
    ['a JPEG cut short', jpeg().slice(0, 40)],
    ['a web page', new TextEncoder().encode('<html><script>alert(1)</script></html>')],
  ])('refuses %s: not a JPEG by its bytes, whatever the request called it', async (_what, bytes) => {
    const w = await setup();

    const refused = await refusal(sendPhoto(w.deps, SARAH, bytes, undefined));

    expect(refused).toMatchObject({ status: 415, code: 'not_a_jpeg', message: 'That is not a picture Wick can take. It needs to be a JPEG.' });
    expectNothingDone(w);
    expect(w.looked).toEqual([]);
  });

  it('refuses while no television is paired, before anything looks at the picture', async () => {
    const w = await setup({ television: false });

    const refused = await refusal(sendPhoto(w.deps, SARAH, jpeg(), undefined));

    expect(refused).toMatchObject({ status: 409, code: 'no_television', message: 'Connect Margaret’s television first. There is nowhere to show her a picture yet.' });
    expectNothingDone(w);
    expect(w.looked).toEqual([]);
  });

  it('refuses a picture moderation refuses — and it is never stored, written down or sent', async () => {
    const w = await setup();
    w.world.verdict = 'refuse';
    const bytes = jpeg(500);

    const refused = await refusal(sendPhoto(w.deps, SARAH, bytes, undefined));

    expect(refused).toMatchObject({ status: 422, code: 'not_sendable', message: 'Wick cannot send that picture.' });
    expect(w.looked).toEqual([bytes]);
    expectNothingDone(w, 1);
  });

  it('FAILS CLOSED: a picture that could not be checked is not sent, and is said differently', async () => {
    const w = await setup();
    w.world.verdict = 'unchecked';

    const refused = await refusal(sendPhoto(w.deps, SARAH, jpeg(), undefined));

    expect(refused).toMatchObject({ status: 503, code: 'not_checked', message: 'Wick could not check that picture just now. Try again in a moment.' });
    expectNothingDone(w, 1);
  });

  it('FAILS CLOSED when the check itself throws', async () => {
    const w = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps: PhotoDeps = { ...w.deps, moderate: async () => { throw new Error('boom'); } };

    expect((await refusal(sendPhoto(deps, SARAH, jpeg(), undefined))).code).toBe('not_checked');
    expectNothingDone(w, 1);
    vi.restoreAllMocks();
  });

  it('says so, and does nothing, where this Wick has no bucket or nothing to check a picture with', async () => {
    const w = await setup();
    for (const missing of ['objects', 'moderate'] as const) {
      const deps: PhotoDeps = { ...w.deps, [missing]: undefined };

      const refused = await refusal(sendPhoto(deps, SARAH, jpeg(), undefined));

      expect(refused).toMatchObject({ status: 503, code: 'photos_unavailable', message: 'This Wick cannot send pictures yet.' });
    }
    expectNothingDone(w);
  });
});

describe('sendPhoto — a mantelpiece is not a feed', () => {
  const sendMany = async (w: Awaited<ReturnType<typeof setup>>, who: typeof SARAH, count: number) => {
    for (let i = 0; i < count; i += 1) await sendPhoto(w.deps, who, jpeg(), undefined);
  };

  it('takes six pictures from one member in a day, and refuses the seventh — saying when another can be sent', async () => {
    const w = await setup();
    expect(MAX_PHOTOS_A_DAY).toBe(6);
    await sendMany(w, SARAH, 6);
    w.looked.length = 0;

    const refused = await refusal(sendPhoto(w.deps, SARAH, jpeg(), undefined));

    expect(refused).toMatchObject({ status: 429, code: 'too_many_today', message: 'You have sent Margaret six pictures today. You can send another tomorrow.' });
    expect(w.cards).toHaveLength(6);
    expect(w.bucket.objects.size).toBe(6);
    // Refused before anything is paid to look at it.
    expect(w.looked).toEqual([]);
  });

  it('counts each member apart: one who has sent six does not use up another’s', async () => {
    const w = await setup();
    await sendMany(w, SARAH, 6);

    await sendPhoto(w.deps, TOM, jpeg(), undefined);

    expect(w.cards).toHaveLength(7);
  });

  it('counts the day where the house is: six sent before her midnight leave six for after it', async () => {
    // 22:40 UTC on 21 September is 23:40 in London: twenty minutes to her midnight.
    const lateEvening = Date.UTC(2026, 8, 21, 22, 40);
    const w = await setup();
    w.world.clock = lateEvening;
    await sendMany(w, SARAH, 6);
    await refusal(sendPhoto(w.deps, SARAH, jpeg(), undefined));

    // Half an hour on it is ten past midnight in London — and still the 21st in UTC.
    w.world.clock = lateEvening + 30 * 60_000;
    await sendPhoto(w.deps, SARAH, jpeg(), undefined);
    expect(w.cards).toHaveLength(7);

    // Where the house is on UTC, the same half hour is still the same day.
    const utc = await setup({ timeZone: 'UTC' });
    utc.world.clock = lateEvening;
    await sendMany(utc, SARAH, 6);
    utc.world.clock = lateEvening + 30 * 60_000;
    expect((await refusal(sendPhoto(utc.deps, SARAH, jpeg(), undefined))).code).toBe('too_many_today');
  });

  it('holds against sendings that cross: the claim is counted again once it is made', async () => {
    const w = await setup();
    await sendMany(w, SARAH, 5);
    // The sixth is counted as allowed — and before it claims its row, another sending of Sarah's lands.
    w.beforeNext((request) => {
      if (request.command !== 'QueryCommand') return;
      w.beforeNext(() => w.beforeNext(() => w.table.put({ pk: { S: 'HH#hh_1' }, sk: { S: 'PHOTO#crossing' }, photoId: { S: 'crossing' }, sentBy: { S: 'u_sarah' }, sentByName: { S: 'Sarah Bennett' }, sentAt: { N: String(NOW) } })));
    });

    const refused = await refusal(sendPhoto(w.deps, SARAH, jpeg(), undefined));

    expect(refused.code).toBe('too_many_today');
    // Its own claim is given up: six rows, not seven; no seventh object, no seventh card.
    expect(w.photoRows().filter((row) => row.sentBy?.S === 'u_sarah')).toHaveLength(6);
    expect(w.bucket.objects.size).toBe(5);
    expect(w.cards).toHaveLength(5);
  });

  it('does not count a picture that was refused, or one whose sending failed, among the six sent', async () => {
    const w = await setup();
    w.world.verdict = 'refuse';
    for (let i = 0; i < 7; i += 1) await refusal(sendPhoto(w.deps, SARAH, jpeg(), undefined));
    w.world.verdict = 'pass';
    w.world.sendFails = true;
    for (let i = 0; i < 7; i += 1) await refusal(sendPhoto(w.deps, SARAH, jpeg(), undefined));
    w.world.sendFails = false;

    await sendMany(w, SARAH, 6);

    expect(w.cards).toHaveLength(6);
  });
});

describe('sendPhoto — tries are bounded, not only sendings', () => {
  const TOO_MANY = { status: 429, code: 'too_many_tries', message: 'That is enough pictures for today. You can try again tomorrow.' };
  const tries = (w: Awaited<ReturnType<typeof setup>>, userId = 'u_sarah') =>
    w.rows().filter((row) => row.sk?.S?.startsWith(`TRY#PHOTO#${userId}#`)).map((row) => `${row.sk!.S} ${row.tries?.N}`);
  const tryMany = async (w: Awaited<ReturnType<typeof setup>>, who: typeof SARAH, count: number) => {
    for (let i = 0; i < count; i += 1) await sendPhoto(w.deps, who, jpeg(), undefined).catch(() => undefined);
  };

  it('refuses the twenty-first try of a member’s day — without looking at the picture, and without storing anything', async () => {
    const w = await setup();
    w.world.verdict = 'refuse';
    await tryMany(w, SARAH, 20);
    expect(w.looked).toHaveLength(20);
    w.requests.length = 0;

    const refused = await refusal(sendPhoto(w.deps, SARAH, jpeg(), undefined));

    expect(refused).toMatchObject(TOO_MANY);
    // Not looked at: the twenty-first costs nothing.
    expect(w.looked).toHaveLength(20);
    expect(w.bucket.sent).toEqual([]);
    expect(w.photoRows()).toEqual([]);
    expect(w.cards).toEqual([]);
    // One write was tried and refused by its own condition: the count stays at twenty.
    expect(tries(w)).toEqual(['TRY#PHOTO#u_sarah#2026-09-21 20']);
    // And so with every one after it, and whatever moderation would now say.
    w.world.verdict = 'pass';
    expect(await refusal(sendPhoto(w.deps, SARAH, jpeg(), undefined))).toMatchObject(TOO_MANY);
    expect(w.looked).toHaveLength(20);
  });

  it('counts a picture that could not be checked like one that was refused', async () => {
    const w = await setup();
    w.world.verdict = 'unchecked';
    await tryMany(w, SARAH, 20);

    w.world.verdict = 'pass';
    expect(await refusal(sendPhoto(w.deps, SARAH, jpeg(), undefined))).toMatchObject(TOO_MANY);
    expect(w.looked).toHaveLength(20);
  });

  it('counts a sending that succeeds, and one that failed after the look, as tries too', async () => {
    const w = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    w.world.verdict = 'refuse';
    await tryMany(w, SARAH, 10);
    w.world.verdict = 'pass';
    w.world.sendFails = true;
    await tryMany(w, SARAH, 5);
    w.world.sendFails = false;
    await tryMany(w, SARAH, 5);
    expect(w.cards).toHaveLength(5);
    expect(tries(w)).toEqual(['TRY#PHOTO#u_sarah#2026-09-21 20']);

    // The sixth sending would be within the six — and is the twenty-first try.
    expect(await refusal(sendPhoto(w.deps, SARAH, jpeg(), undefined))).toMatchObject(TOO_MANY);
    expect(w.cards).toHaveLength(5);
    vi.restoreAllMocks();
  });

  it('leaves the lower cap the one a member meets first: six sent is six tries, and the seventh is refused as before', async () => {
    const w = await setup();
    await tryMany(w, SARAH, 6);

    expect((await refusal(sendPhoto(w.deps, SARAH, jpeg(), undefined))).code).toBe('too_many_today');
    // Refused for the six before it was a try: the count of tries does not move.
    expect(tries(w)).toEqual(['TRY#PHOTO#u_sarah#2026-09-21 6']);
  });

  it('does not count a second try at a picture already sent: it is answered as the first was, and nothing looks at it', async () => {
    const w = await setup();
    await sendPhoto(w.deps, SARAH, jpeg(), 'one-picture');

    for (let i = 0; i < 30; i += 1) expect(await sendPhoto(w.deps, SARAH, jpeg(), 'one-picture')).toMatchObject({ sent: true, photoId: 'one-picture' });

    expect(tries(w)).toEqual(['TRY#PHOTO#u_sarah#2026-09-21 1']);
    expect(w.looked).toHaveLength(1);
  });

  it('does not count what is refused before a picture would be looked at', async () => {
    const w = await setup({ television: false });
    await tryMany(w, SARAH, 3);
    await sendPhoto(w.deps, SARAH, new Uint8Array([1, 2, 3]), undefined).catch(() => undefined);
    await sendPhoto(w.deps, SARAH, jpeg(), 'a b').catch(() => undefined);

    expect(tries(w)).toEqual([]);
  });

  it('counts each member apart, and only in their own household', async () => {
    const w = await setup();
    w.world.verdict = 'refuse';
    await tryMany(w, SARAH, 20);

    await tryMany(w, TOM, 2);
    await tryMany(w, { householdId: 'hh_2', userId: 'u_priya' }, 1);

    expect(w.looked).toHaveLength(23);
    expect(tries(w, 'u_tom')).toEqual(['TRY#PHOTO#u_tom#2026-09-21 2']);
    expect(w.rows('hh_2').filter((row) => row.sk?.S?.startsWith('TRY#PHOTO#')).map((row) => `${row.sk!.S} ${row.tries?.N}`)).toEqual(['TRY#PHOTO#u_priya#2026-09-21 1']);
  });

  it('counts the day where the house is: twenty before her midnight leave twenty for after it', async () => {
    // 22:40 UTC on 21 September is 23:40 in London: twenty minutes to her midnight.
    const lateEvening = Date.UTC(2026, 8, 21, 22, 40);
    const w = await setup();
    w.world.verdict = 'refuse';
    w.world.clock = lateEvening;
    await tryMany(w, SARAH, 21);
    expect(w.looked).toHaveLength(20);

    w.world.clock = lateEvening + 30 * 60_000;
    await tryMany(w, SARAH, 1);
    expect(w.looked).toHaveLength(21);
    expect(tries(w)).toEqual(['TRY#PHOTO#u_sarah#2026-09-21 20', 'TRY#PHOTO#u_sarah#2026-09-22 1']);

    // Where the house is on UTC, the same half hour is still the same day.
    const utc = await setup({ timeZone: 'UTC' });
    utc.world.verdict = 'refuse';
    utc.world.clock = lateEvening;
    await tryMany(utc, SARAH, 20);
    utc.world.clock = lateEvening + 30 * 60_000;
    expect((await refusal(sendPhoto(utc.deps, SARAH, jpeg(), undefined))).code).toBe('too_many_tries');
  });

  it('keeps the count two days, and nowhere a listing of pictures would read it', async () => {
    const w = await setup();
    w.world.verdict = 'refuse';
    await tryMany(w, SARAH, 3);

    const [row] = w.rows().filter((held) => held.sk?.S?.startsWith('TRY#'));
    expect(row).toEqual({ pk: { S: 'HH#hh_1' }, sk: { S: 'TRY#PHOTO#u_sarah#2026-09-21' }, tries: { N: '3' }, ttl: { N: String(Math.floor((NOW + 2 * DAY) / 1000)) } });
    expect(await loadSentPictures(w.deps.ddb, SARAH, 'Margaret', NOW)).toEqual([]);
    // And it does not use up any of the six.
    w.world.verdict = 'pass';
    for (let i = 0; i < 6; i += 1) await sendPhoto(w.deps, SARAH, jpeg(), undefined);
    expect(w.cards).toHaveLength(6);
  });

  it('when tries cross, no more than twenty are ever looked at: the count and its cap are one write', async () => {
    const w = await setup();
    w.world.verdict = 'refuse';

    const results = await Promise.allSettled(Array.from({ length: 45 }, () => sendPhoto(w.deps, SARAH, jpeg(), undefined)));

    expect(w.looked).toHaveLength(20);
    const codes = results.map((result) => (result.status === 'rejected' ? (result.reason as PhotoRefusal).code : 'sent'));
    expect(codes.filter((code) => code === 'not_sendable')).toHaveLength(20);
    expect(codes.filter((code) => code === 'too_many_tries')).toHaveLength(25);
    expect(tries(w)).toEqual(['TRY#PHOTO#u_sarah#2026-09-21 20']);
  });

  it('FAILS CLOSED: if the try cannot be counted, the picture is not looked at and nothing is sent', async () => {
    const w = await setup();
    const broken = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'UpdateItemCommand') throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' });
        return (w.deps.ddb as unknown as { send: (c: unknown) => Promise<unknown> }).send(command);
      },
    } as unknown as DynamoDBClient;

    await expect(sendPhoto({ ...w.deps, ddb: broken }, SARAH, jpeg(), undefined)).rejects.toMatchObject({ name: 'ProvisionedThroughputExceededException' });

    expect(w.looked).toEqual([]);
    expect(w.bucket.sent).toEqual([]);
    expect(w.cards).toEqual([]);
  });
});

describe('sendPhoto — sent once, however often it is tried (INV-6)', () => {
  it('uses the key the app made as the picture’s id, so a second try sends nothing again and answers as the first did', async () => {
    const w = await setup();
    const key = 'k3y-From_the-App-0123456789abcdef';

    const first = await sendPhoto(w.deps, SARAH, jpeg(300), key);
    w.world.clock = NOW + 5000;
    const again = await sendPhoto(w.deps, SARAH, jpeg(300), key);

    expect(first).toEqual({ sent: true, photoId: key, say: 'Your picture is on its way to Margaret’s television. It will wait for a quiet moment.' });
    expect(again).toEqual(first);
    expect(w.cards.map((card) => card.id)).toEqual([`photo-${key}`]);
    expect(w.bucket.sent.map((request) => request.name)).toEqual(['PutObjectCommand']);
    expect(w.photoRows()).toHaveLength(1);
    expect(w.photoRows()[0]!.sentAt).toEqual({ N: String(NOW) });
    // The second try was not looked at again: there was nothing left to decide.
    expect(w.looked).toHaveLength(1);
  });

  it('answers a second try as the first even when the day’s six are used up, or the television has since gone', async () => {
    const w = await setup();
    const key = 'the-sixth';
    for (let i = 0; i < 5; i += 1) await sendPhoto(w.deps, SARAH, jpeg(), undefined);
    await sendPhoto(w.deps, SARAH, jpeg(), key);
    await w.store.removeTelevision(HH, 'tv-1');

    expect(await sendPhoto(w.deps, SARAH, jpeg(), key)).toMatchObject({ sent: true, photoId: key });
    expect(w.cards).toHaveLength(6);
  });

  it('still asks who is sending, every time: a second try by somebody since removed is refused', async () => {
    const w = await setup();
    await sendPhoto(w.deps, TOM, jpeg(), 'toms-picture');
    await w.store.setMemberStatus(HH, 'u_tom', 'removed', NOW);

    expect((await refusal(sendPhoto(w.deps, TOM, jpeg(), 'toms-picture'))).status).toBe(403);
  });

  it('never sends over somebody else’s picture: another member’s id is refused, and nothing of theirs is touched', async () => {
    const w = await setup();
    const toms = jpeg(400, 1);
    await sendPhoto(w.deps, TOM, toms, 'toms-picture');
    w.bucket.sent.length = 0;

    const refused = await refusal(sendPhoto(w.deps, SARAH, jpeg(400, 9), 'toms-picture'));

    expect(refused).toMatchObject({ status: 409, code: 'key_in_use', message: 'That picture could not be sent. Choose it again.' });
    expect(w.bucket.sent).toEqual([]);
    expect(w.bucket.objects.get('photos/hh_1/toms-picture.jpg')?.bytes).toEqual(toms);
    expect(w.photoRows()).toHaveLength(1);
    expect(w.photoRows()[0]).toMatchObject({ sentBy: { S: 'u_tom' } });
    expect(w.cards).toHaveLength(1);
  });

  it('cannot change a picture she has already seen: the same key with other bytes stores nothing', async () => {
    const w = await setup();
    const shown = jpeg(400, 1);
    await sendPhoto(w.deps, SARAH, shown, 'kept-one');
    w.residentPresses('kept-one', 'keep');

    await sendPhoto(w.deps, SARAH, jpeg(400, 9), 'kept-one');

    expect(w.bucket.objects.get('photos/hh_1/kept-one.jpg')?.bytes).toEqual(shown);
    expect(w.cards).toHaveLength(1);
  });

  it.each([[''], ['a b'], ['../../hh_2/x'], ['a/b'], ['x'.repeat(65)], ['naïve'], ['photos%2Fhh_2']])('refuses a key that is not shaped like a picture’s id (%j), rather than send without one', async (key) => {
    const w = await setup();

    const refused = await refusal(sendPhoto(w.deps, SARAH, jpeg(), key));

    expect(refused).toMatchObject({ status: 400, code: 'bad_key', message: 'That picture could not be sent. Choose it again.' });
    expectNothingDone(w);
  });

  it('when two tries with one key cross, one picture is sent', async () => {
    const w = await setup();

    const results = await Promise.allSettled([sendPhoto(w.deps, SARAH, jpeg(), 'crossing'), sendPhoto(w.deps, SARAH, jpeg(), 'crossing')]);

    expect(results.filter((result) => result.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(w.cards).toHaveLength(1);
    expect(w.photoRows()).toHaveLength(1);
    expect(w.bucket.objects.size).toBe(1);
  });
});

describe('sendPhoto — a sending that fails is undone', () => {
  it('when the picture cannot be stored: the row is given up, no card is sent, and it is said plainly', async () => {
    const w = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    w.bucket.failing = true;

    const refused = await refusal(sendPhoto(w.deps, SARAH, jpeg(), 'p1'));

    expect(refused).toMatchObject({
      status: 502,
      code: 'not_sent',
      message: 'Your picture could not be sent just now. Nothing reached Margaret’s television. Try again in a moment.',
    });
    expect(w.photoRows()).toEqual([]);
    expect(w.cards).toEqual([]);

    // And the same picture, tried again with the same key, is sent.
    w.bucket.failing = false;
    expect(await sendPhoto(w.deps, SARAH, jpeg(), 'p1')).toMatchObject({ sent: true, photoId: 'p1' });
    vi.restoreAllMocks();
  });

  it('when the card cannot be sent: the picture is taken out of the bucket, the row given up, and a card half sent taken back', async () => {
    const w = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    w.world.sendFails = true;

    const refused = await refusal(sendPhoto(w.deps, SARAH, jpeg(), 'p1'));

    expect(refused.code).toBe('not_sent');
    expect(w.bucket.sent.map((request) => request.name)).toEqual(['PutObjectCommand', 'DeleteObjectCommand']);
    expect(w.bucket.objects.size).toBe(0);
    expect(w.photoRows()).toEqual([]);
    // The card is stored before it is pushed (egress.ts): one that would arrive later, with no picture behind it, is taken back.
    expect(w.withdrawn).toEqual([{ householdId: HH, cardId: 'photo-p1' }]);
    vi.restoreAllMocks();
  });

  it('never removes an object it did not put: one already there under that id stays as it was', async () => {
    const w = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const there = jpeg(200, 3);
    w.bucket.objects.set('photos/hh_1/p1.jpg', { bytes: there, contentType: 'image/jpeg', tagging: 'state=kept' });

    const refused = await refusal(sendPhoto(w.deps, SARAH, jpeg(200, 9), 'p1'));

    expect(refused.code).toBe('not_sent');
    expect(w.bucket.sent.map((request) => request.name)).toEqual(['PutObjectCommand']);
    expect(w.bucket.objects.get('photos/hh_1/p1.jpg')).toEqual({ bytes: there, contentType: 'image/jpeg', tagging: 'state=kept' });
    expect(w.photoRows()).toEqual([]);
    expect(w.cards).toEqual([]);
    vi.restoreAllMocks();
  });

  it('says it could not be sent even when the undoing fails too, and tells no more than that', async () => {
    const w = await setup();
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    const deps: PhotoDeps = {
      ...w.deps,
      sendCard: async () => {
        w.bucket.failing = true;
        throw new Error('egress is down: arn:aws:iot:eu-west-2:123456789012:thing/x');
      },
      withdrawCard: async () => {
        throw new Error('still down');
      },
    };

    const refused = await refusal(sendPhoto(deps, SARAH, jpeg(), 'p1'));

    expect(refused.message).toBe('Your picture could not be sent just now. Nothing reached Margaret’s television. Try again in a moment.');
    expect(logged.join('\n')).not.toMatch(/arn:aws|123456789012|u_sarah|hh_1|p1\b/);
    vi.restoreAllMocks();
  });
});

describe('loadSentPictures — what a member is told of their own pictures', () => {
  it('lists the member’s own, newest first, each waiting until she has seen it', async () => {
    const w = await setup();
    await sendPhoto(w.deps, SARAH, jpeg(), 'first');
    w.world.clock = NOW + HOUR;
    await sendPhoto(w.deps, SARAH, jpeg(), 'second');
    w.residentPresses('first', 'thanks');

    expect(await loadSentPictures(w.deps.ddb, SARAH, 'Margaret', NOW + 2 * HOUR)).toEqual([
      { photoId: 'second', sentAt: NOW + HOUR, seen: false, say: 'It is waiting on Margaret’s television.' },
      { photoId: 'first', sentAt: NOW, seen: true, say: 'Margaret has seen your picture.' },
    ]);
  });

  it('shows nobody another member’s pictures — the organiser no more than anyone', async () => {
    const w = await setup();
    await sendPhoto(w.deps, TOM, jpeg(), 'toms');
    await sendPhoto(w.deps, SARAH, jpeg(), 'sarahs');

    expect((await loadSentPictures(w.deps.ddb, SARAH, 'Margaret', NOW)).map((picture) => picture.photoId)).toEqual(['sarahs']);
    expect((await loadSentPictures(w.deps.ddb, TOM, 'Margaret', NOW)).map((picture) => picture.photoId)).toEqual(['toms']);
    expect(await loadSentPictures(w.deps.ddb, { householdId: 'hh_2', userId: 'u_priya' }, 'Edith', NOW)).toEqual([]);
  });

  it('goes back seven days, and no further; ten pictures, and no more', async () => {
    const w = await setup();
    for (let day = 9; day >= 0; day -= 1) {
      w.world.clock = NOW - day * DAY;
      await sendPhoto(w.deps, SARAH, jpeg(), `day-${day}-a`);
      await sendPhoto(w.deps, SARAH, jpeg(), `day-${day}-b`);
    }

    const listed = await loadSentPictures(w.deps.ddb, SARAH, 'Margaret', NOW + 1);

    expect(listed).toHaveLength(10);
    expect(listed[0]!.photoId).toMatch(/^day-0-/);
    expect(listed.every((picture) => picture.sentAt > NOW - 7 * DAY)).toBe(true);
    expect((await loadSentPictures(w.deps.ddb, SARAH, 'Margaret', NOW + 8 * DAY)).length).toBe(0);
  });

  it('does not say when she saw it: seen, and nothing more', async () => {
    const w = await setup();
    await sendPhoto(w.deps, SARAH, jpeg(), 'one');
    w.world.clock = NOW + 3 * HOUR;
    w.residentPresses('one', 'keep');

    const [picture] = await loadSentPictures(w.deps.ddb, SARAH, 'Margaret', NOW + 4 * HOUR);

    expect(Object.keys(picture!).sort()).toEqual(['photoId', 'say', 'seen', 'sentAt']);
    expect(JSON.stringify(picture)).not.toContain(String(NOW + 3 * HOUR));
  });
});

/**
 * THE RULE (packages/contracts mantel.ts): the family is told one thing,
 * whichever she pressed — that she has seen it. Kept, not kept and taken
 * down a week later must look exactly the same from here. They do, because
 * nothing here can ask: this server never reads what is on her
 * mantelpiece, never the card or what was pressed on it, and never whether
 * a picture's bytes are still there or how they are tagged.
 */
describe('kept, not kept and taken down look exactly the same', () => {
  async function told(what: 'keep' | 'thanks' | 'keep, then taken down') {
    const w = await setup();
    await sendPhoto(w.deps, SARAH, jpeg(), 'the-picture');
    w.world.clock = NOW + HOUR;
    w.residentPresses('the-picture', what === 'thanks' ? 'thanks' : 'keep');
    if (what === 'keep, then taken down') w.residentTakesDown('the-picture');
    // And the bucket's own side of it, which this server must not be able to see either.
    if (what === 'thanks') w.bucket.objects.delete('photos/hh_1/the-picture.jpg');
    w.requests.length = 0;
    w.bucket.sent.length = 0;

    const listed = await loadSentPictures(w.deps.ddb, SARAH, 'Margaret', NOW + 2 * HOUR);
    const retried = await sendPhoto(w.deps, SARAH, jpeg(), 'the-picture');
    return { w, answers: JSON.stringify([listed, retried]) };
  }

  it('to the member who sent it: the same answers, byte for byte', async () => {
    const kept = await told('keep');
    const thanked = await told('thanks');
    const takenDown = await told('keep, then taken down');

    expect(thanked.answers).toBe(kept.answers);
    expect(takenDown.answers).toBe(kept.answers);
    expect(kept.answers).toContain('Margaret has seen your picture.');
  });

  it('because nothing reads her mantelpiece, the card, or the bucket: every request made, through every flow', async () => {
    for (const what of ['keep', 'thanks', 'keep, then taken down'] as const) {
      const { w } = await told(what);
      await sendPhoto(w.deps, TOM, jpeg(), undefined);
      await loadSentPictures(w.deps.ddb, TOM, 'Margaret', NOW + 3 * HOUR);
      w.world.verdict = 'refuse';
      await sendPhoto(w.deps, TOM, jpeg(), undefined).catch(() => undefined);

      // The table: a picture's own row, by its key or by the prefix all of them share — and the sender's own count of
      // tries, which is added to and never read. Nothing else of the household's.
      expect(w.requests.length).toBeGreaterThan(4);
      for (const request of w.requests) {
        expect(request.pk).toBe('HH#hh_1');
        const counting = request.command === 'UpdateItemCommand' && /^TRY#PHOTO#u_(sarah|tom)#\d{4}-\d{2}-\d{2}$/.test(request.sk);
        expect(request.sk.startsWith('PHOTO#') || counting, `${request.command} ${request.sk}`).toBe(true);
        expect(request.sk).not.toContain('MANTEL');
        expect(request.sk).not.toContain('CARD');
      }
      // The bucket: a picture is put there. It is never read, looked for, or asked how it is tagged.
      expect(w.bucket.sent.map((request) => request.name)).toEqual(['PutObjectCommand']);
    }
  });

  it('and no source file of this server so much as names her mantelpiece, or reads from the bucket', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const sources = (readdirSync(root, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.ts') && !file.split(/[\\/]/).includes('__tests__'))
      .map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }));
    expect(sources.length).toBeGreaterThan(45);

    for (const { file, text } of sources) {
      // In code. A comment may say what is not done.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/MANTEL/);
      expect(code, file).not.toMatch(/GetObject|HeadObject|ListObjects|ObjectTagging|ObjectAttributes|getSignedUrl|s3-request-presigner/);
      expect(code, file).not.toMatch(/CARD#photo/);
    }
    // The only S3 requests there are: a put, and the delete that undoes it.
    const s3 = sources.filter(({ text }) => /@aws-sdk\/client-s3/.test(text)).map(({ file }) => file.replace(/\\/g, '/'));
    expect(s3.sort()).toEqual(['index.ts', 'photos/objects.ts']);
  });
});
