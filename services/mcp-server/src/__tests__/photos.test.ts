/**
 * /api/photos over a real socket: the mantelpiece, the sending
 * (photos/send.ts). What the route itself adds to that — how a picture
 * arrives (raw JPEG bytes, a size, a type), who is refused before a byte of
 * it is read, and that nothing in a request can name a household, a key or
 * an address (INV-8).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PHOTO_BYTES, isPhotoId, type QueuedCard } from '@wick/contracts';
import type { AppDeps } from '../server.js';
import type { ModerationVerdict } from '../photos/moderation.js';
import { createS3PhotoObjects } from '../photos/objects.js';
import { createMemoryObjects, type MemoryObjects } from '../photos/__tests__/memoryObjects.js';
import { Browser, beginAuthorize, exchangeCode, linkInvited, linkNewOrganiser, registerClient, residentAllows, startServer, TOM, type Harness, type Linked, type Tokens } from './harness.js';
import { createMemoryTable, type MemoryTable } from './memoryTable.js';

const closers: (() => Promise<void>)[] = [];

interface World {
  readonly h: Harness;
  readonly table: MemoryTable;
  readonly bucket: MemoryObjects;
  readonly looked: Uint8Array[];
  verdict: ModerationVerdict;
  photoCards(): QueuedCard[];
  photoRows(householdId: string): Record<string, { S?: string; N?: string }>[];
}

async function server(overrides: Partial<AppDeps> = {}): Promise<World> {
  const table = createMemoryTable();
  const bucket = createMemoryObjects();
  const looked: Uint8Array[] = [];
  const world = { verdict: 'pass' as ModerationVerdict };
  const h = await startServer({
    ddb: table.ddb,
    photos: {
      objects: createS3PhotoObjects(bucket.send, 'wick-photos-test'),
      moderate: async (bytes) => {
        looked.push(bytes);
        return world.verdict;
      },
    },
    ...overrides,
  });
  closers.push(h.close);
  return {
    h,
    table,
    bucket,
    looked,
    get verdict() {
      return world.verdict;
    },
    set verdict(value: ModerationVerdict) {
      world.verdict = value;
    },
    photoCards: () => h.cards.filter((card) => card.card.type === 'PHOTO'),
    photoRows: (householdId) => table.rows(`HH#${householdId}`).filter((row) => row.sk?.S?.startsWith('PHOTO#')),
  };
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  vi.restoreAllMocks();
});

type Who = Pick<Linked, 'tokens'>;

/** Bytes that are a JPEG by their markers and nothing else: made here, never a photograph. */
const jpeg = (length = 512, fill = 7): Uint8Array => {
  const bytes = new Uint8Array(length).fill(fill);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.set([0xff, 0xd9], length - 2);
  return bytes;
};

const send = (h: Harness, who: Who, body: Uint8Array | string, headers: Record<string, string> = { 'content-type': 'image/jpeg' }, path = '/api/photos') =>
  fetch(`${h.base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${who.tokens.access_token}`, ...headers }, body });
const list = (h: Harness, who: Who, path = '/api/photos') => fetch(`${h.base}${path}`, { headers: { authorization: `Bearer ${who.tokens.access_token}` } });

const JUNE = { name: 'June', email: 'june@example.com', password: 'a neighbourly passphrase' };
const PRIYA = { name: 'Priya', email: 'priya@example.com', password: 'another long passphrase' };
const ON_ITS_WAY = 'Your picture is on its way to Margaret’s television. It will wait for a quiet moment.';

async function invite(h: Harness, organiser: Linked, role?: 'neighbour'): Promise<string> {
  const res = await fetch(`${h.base}/api/circle/invitations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${organiser.tokens.access_token}`, ...(role ? { 'content-type': 'application/json' } : {}) },
    ...(role ? { body: JSON.stringify({ role }) } : {}),
  });
  return ((await res.json()) as { code: string }).code;
}

/** Margaret's home, her television connected, Sarah its organiser and allowed. */
async function home(overrides: Partial<AppDeps> = {}) {
  const w = await server(overrides);
  const sarah = await linkNewOrganiser(w.h);
  await residentAllows(w.h, sarah.householdId, sarah.userId);
  w.h.store.addTelevision(sarah.householdId, { deviceId: 'tv-1', pairedAt: 5, connected: true });
  return Object.assign(w, { sarah });
}

describe('POST /api/photos — a picture for her television', () => {
  it('takes the raw JPEG, stores it, and puts one card on her television', async () => {
    const w = await home();
    const bytes = jpeg(4096);

    const res = await send(w.h, w.sarah, bytes);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: boolean; photoId: string; say: string };
    expect(body).toEqual({ sent: true, photoId: expect.any(String) as string, say: ON_ITS_WAY });
    expect(isPhotoId(body.photoId)).toBe(true);
    // An id nobody could guess.
    expect(body.photoId.length).toBeGreaterThanOrEqual(16);

    const key = `photos/${w.sarah.householdId}/${body.photoId}.jpg`;
    expect([...w.bucket.objects.keys()]).toEqual([key]);
    expect(Buffer.from(w.bucket.objects.get(key)!.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(w.bucket.objects.get(key)).toMatchObject({ contentType: 'image/jpeg', tagging: 'state=sent' });
    expect(w.photoCards()).toHaveLength(1);
    expect(w.photoCards()[0]).toMatchObject({
      id: `photo-${body.photoId}`,
      urgency: 'DEFERRED',
      card: { type: 'PHOTO', photoId: body.photoId, householdId: w.sarah.householdId, fromName: 'Sarah', headline: 'A picture from Sarah.' },
    });
    expect(w.photoRows(w.sarah.householdId)).toHaveLength(1);
    // The family app is served from another origin.
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('lets the family app’s browser send it: the preflight allows the two headers it sets', async () => {
    const w = await home();

    const res = await fetch(`${w.h.base}/api/photos`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,idempotency-key' },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('idempotency-key');
  });

  it('is for someone signed in', async () => {
    const w = await home();

    expect((await fetch(`${w.h.base}/api/photos`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: jpeg() })).status).toBe(401);
    expect((await fetch(`${w.h.base}/api/photos`)).status).toBe(401);
    expect(w.bucket.sent).toEqual([]);
  });

  it.each([
    ['image/png'],
    ['image/webp'],
    ['application/octet-stream'],
    ['application/json'],
    ['text/plain'],
    ['multipart/form-data; boundary=x'],
    ['image/jpeg2000'],
  ])('refuses %s with 415: Wick takes a JPEG and nothing else', async (contentType) => {
    const w = await home();

    const res = await send(w.h, w.sarah, contentType === 'application/json' ? '{"a":1}' : jpeg(), { 'content-type': contentType });

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'not_a_jpeg', message: 'That is not a picture Wick can take. It needs to be a JPEG.' });
    expect(w.bucket.sent).toEqual([]);
    expect(w.looked).toEqual([]);
  });

  it('refuses bytes that are not a JPEG whatever the request called them, and no body at all', async () => {
    const w = await home();

    for (const body of [new TextEncoder().encode('<html>not a picture</html>'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), new Uint8Array()]) {
      const res = await send(w.h, w.sarah, body);
      expect(res.status).toBe(415);
      expect(await res.json()).toMatchObject({ error: 'not_a_jpeg' });
    }
    expect(w.bucket.sent).toEqual([]);
    expect(w.looked).toEqual([]);
  });

  it('takes a picture of exactly the largest size, and refuses one byte more with 413 and a plain sentence', async () => {
    const w = await home();

    expect((await send(w.h, w.sarah, jpeg(MAX_PHOTO_BYTES))).status).toBe(200);

    const res = await send(w.h, w.sarah, jpeg(MAX_PHOTO_BYTES + 1));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large', message: 'That picture is too large. Wick takes pictures up to 1.5 MB.' });
    expect(w.bucket.objects.size).toBe(1);
    expect(w.photoCards()).toHaveLength(1);
  });

  it('INV-9: tells somebody she has not allowed nothing but that — whatever they send, however large', async () => {
    const w = await home();
    const tom = await linkInvited(w.h, TOM, await invite(w.h, w.sarah));

    for (const [body, headers] of [
      [jpeg(), { 'content-type': 'image/jpeg' }],
      [jpeg(MAX_PHOTO_BYTES + 50_000), { 'content-type': 'image/jpeg' }],
      [new TextEncoder().encode('nonsense'), { 'content-type': 'text/plain' }],
    ] as const) {
      const res = await send(w.h, tom, body, headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'not_allowed_yet',
        message: 'Margaret hasn’t allowed this yet. A card is waiting on the television, and it only takes one press.',
      });
    }
    expect((await list(w.h, tom)).status).toBe(403);

    await residentAllows(w.h, tom.householdId, tom.userId);
    expect((await send(w.h, tom, jpeg())).status).toBe(200);
    expect(w.photoCards()[0]!.card).toMatchObject({ fromName: 'Tom' });

    // And once removed, nothing again — on the very next request.
    await fetch(`${w.h.base}/api/circle/members/${tom.userId}`, { method: 'DELETE', headers: { authorization: `Bearer ${w.sarah.tokens.access_token}` } });
    const removed = await send(w.h, tom, jpeg());
    expect(removed.status).toBe(403);
    expect(await removed.json()).toEqual({ error: 'not_allowed_yet', message: 'You are no longer part of this family circle.' });
    expect((await list(w.h, tom)).status).toBe(403);
    expect(w.photoCards()).toHaveLength(1);
  });

  it('refuses an organiser she has not allowed yet, or has turned down', async () => {
    const w = await server();
    const sarah = await linkNewOrganiser(w.h);
    w.h.store.addTelevision(sarah.householdId, { deviceId: 'tv-1', pairedAt: 5, connected: true });

    expect((await send(w.h, sarah, jpeg())).status).toBe(403);
    await w.h.store.setMemberStatus(sarah.householdId, sarah.userId, 'declined', Date.now());
    const declined = await send(w.h, sarah, jpeg());
    expect(declined.status).toBe(403);
    expect(await declined.json()).toEqual({ error: 'not_allowed_yet', message: 'Margaret chose not to share this with you.' });
    expect(w.bucket.sent).toEqual([]);
  });

  it('is not for a neighbour, allowed or not: neither to send nor to list', async () => {
    const w = await home();
    const june = await linkInvited(w.h, JUNE, await invite(w.h, w.sarah, 'neighbour'));

    for (const allowed of [false, true]) {
      if (allowed) await residentAllows(w.h, june.householdId, june.userId);
      for (const res of [await send(w.h, june, jpeg()), await list(w.h, june)]) {
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'not_for_a_neighbour', message: 'A neighbour cannot send a picture.' });
      }
    }
    expect(w.bucket.sent).toEqual([]);
    expect(w.photoCards()).toEqual([]);
  });

  it('refuses while no television is paired', async () => {
    const w = await server();
    const sarah = await linkNewOrganiser(w.h);
    await residentAllows(w.h, sarah.householdId, sarah.userId);

    const res = await send(w.h, sarah, jpeg());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no_television', message: 'Connect Margaret’s television first. There is nowhere to show her a picture yet.' });
  });

  it('refuses a picture moderation refuses, and one it could not check — and stores neither', async () => {
    const w = await home();

    w.verdict = 'refuse';
    const refused = await send(w.h, w.sarah, jpeg());
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: 'not_sendable', message: 'Wick cannot send that picture.' });

    w.verdict = 'unchecked';
    const unchecked = await send(w.h, w.sarah, jpeg());
    expect(unchecked.status).toBe(503);
    expect(await unchecked.json()).toEqual({ error: 'not_checked', message: 'Wick could not check that picture just now. Try again in a moment.' });

    expect(w.looked).toHaveLength(2);
    expect(w.bucket.sent).toEqual([]);
    expect(w.photoRows(w.sarah.householdId)).toEqual([]);
    expect(w.photoCards()).toEqual([]);
  });

  it('refuses the seventh picture of a member’s day, and says when another can be sent', async () => {
    const w = await home();
    for (let i = 0; i < 6; i += 1) expect((await send(w.h, w.sarah, jpeg())).status).toBe(200);

    const res = await send(w.h, w.sarah, jpeg());

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'too_many_today', message: 'You have sent Margaret six pictures today. You can send another tomorrow.' });
    expect(w.photoCards()).toHaveLength(6);
  });

  it('bounds tries as well as sendings: the twenty-first of a member’s day is refused before anything looks at it', async () => {
    const w = await home();
    w.verdict = 'refuse';
    for (let i = 0; i < 20; i += 1) expect((await send(w.h, w.sarah, jpeg())).status).toBe(422);

    w.verdict = 'pass';
    const res = await send(w.h, w.sarah, jpeg());

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'too_many_tries', message: 'That is enough pictures for today. You can try again tomorrow.' });
    expect(w.looked).toHaveLength(20);
    expect(w.bucket.sent).toEqual([]);
    expect(w.photoCards()).toEqual([]);
    // The count is the member's own, kept apart from any picture: the list reads none of it.
    expect(await (await list(w.h, w.sarah)).json()).toEqual({ photos: [] });
    expect(w.table.rows(`HH#${w.sarah.householdId}`).filter((row) => row.sk?.S?.startsWith('TRY#PHOTO#')).map((row) => row.tries?.N)).toEqual(['20']);
  });

  it('says it could not be sent, in words and nothing else, when her television could not be reached — and leaves nothing behind', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = await home({
      sendCard: async (card) => {
        if (card.card.type === 'PHOTO') throw new Error('egress is down: arn:aws:iot:eu-west-2:123456789012:thing/x');
      },
    });

    const res = await send(w.h, w.sarah, jpeg());

    expect(res.status).toBe(502);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({
      error: 'not_sent',
      message: 'Your picture could not be sent just now. Nothing reached Margaret’s television. Try again in a moment.',
    });
    expect(body).not.toContain('arn:aws');
    expect(w.bucket.objects.size).toBe(0);
    expect(w.photoRows(w.sarah.householdId)).toEqual([]);
  });

  it('says so where this Wick has no bucket or no moderation — and still lists, since nothing was ever sent', async () => {
    const w = await home({ photos: undefined });

    const res = await send(w.h, w.sarah, jpeg());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'photos_unavailable', message: 'This Wick cannot send pictures yet.' });
    expect(await (await list(w.h, w.sarah)).json()).toEqual({ photos: [] });
  });
});

describe('Idempotency-Key — one picture, however often its sending is tried (INV-6)', () => {
  it('uses the key as the picture’s id, and answers a second try as the first without sending again', async () => {
    const w = await home();
    const key = 'c0ffee00-From_the-App-0123456789';
    const headers = { 'content-type': 'image/jpeg', 'idempotency-key': key };

    const first = await send(w.h, w.sarah, jpeg(), headers);
    const again = await send(w.h, w.sarah, jpeg(), headers);

    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    const answer = { sent: true, photoId: key, say: ON_ITS_WAY };
    expect(await first.json()).toEqual(answer);
    expect(await again.json()).toEqual(answer);
    expect(w.photoCards()).toHaveLength(1);
    expect([...w.bucket.objects.keys()]).toEqual([`photos/${w.sarah.householdId}/${key}.jpg`]);
    expect(w.looked).toHaveLength(1);
  });

  it.each([['a b'], ['../../other/x'], ['x'.repeat(65)], ['photos%2Fother']])('refuses a key that is not shaped like a picture’s id (%j)', async (key) => {
    const w = await home();

    const res = await send(w.h, w.sarah, jpeg(), { 'content-type': 'image/jpeg', 'idempotency-key': key });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_key', message: 'That picture could not be sent. Choose it again.' });
    expect(w.bucket.sent).toEqual([]);
  });

  it('cannot be used to send over another member’s picture', async () => {
    const w = await home();
    const tom = await linkInvited(w.h, TOM, await invite(w.h, w.sarah));
    await residentAllows(w.h, tom.householdId, tom.userId);
    const toms = jpeg(900, 1);
    await send(w.h, tom, toms, { 'content-type': 'image/jpeg', 'idempotency-key': 'toms-picture' });

    const res = await send(w.h, w.sarah, jpeg(900, 9), { 'content-type': 'image/jpeg', 'idempotency-key': 'toms-picture' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'key_in_use', message: 'That picture could not be sent. Choose it again.' });
    expect(Buffer.from(w.bucket.objects.get(`photos/${tom.householdId}/toms-picture.jpg`)!.bytes).equals(Buffer.from(toms))).toBe(true);
    expect(w.photoCards()).toHaveLength(1);
  });
});

describe('INV-8: the household is the token’s — no request can name another, or where a picture goes', () => {
  it('stores and sends in the sender’s own home, whatever a request names', async () => {
    const w = await home();
    const priya = await linkNewOrganiser(w.h, PRIYA, 'Asha');
    await residentAllows(w.h, priya.householdId, priya.userId);
    w.h.store.addTelevision(priya.householdId, { deviceId: 'tv-2', pairedAt: 5, connected: true });
    const theirs = priya.householdId;

    const res = await send(
      w.h,
      w.sarah,
      jpeg(),
      {
        'content-type': 'image/jpeg',
        'x-household-id': theirs,
        'x-photo-id': 'chosen',
        'x-amz-meta-household': theirs,
        'x-object-key': `photos/${theirs}/chosen.jpg`,
        'x-from-name': 'Dr Patel, her doctor',
      },
      `/api/photos?householdId=${theirs}&household=${theirs}&photoId=chosen&key=photos/${theirs}/chosen.jpg&bucket=other&fromName=Dr+Patel&url=https://evil.example/x.jpg`,
    );

    expect(res.status).toBe(200);
    const { photoId } = (await res.json()) as { photoId: string };
    expect(photoId).not.toBe('chosen');
    expect([...w.bucket.objects.keys()]).toEqual([`photos/${w.sarah.householdId}/${photoId}.jpg`]);
    expect(w.bucket.sent.every((request) => request.input.Bucket === 'wick-photos-test')).toBe(true);
    expect(w.photoRows(theirs)).toEqual([]);
    expect(w.photoCards().map((card) => card.card.householdId)).toEqual([w.sarah.householdId]);
    // The name on the card is the membership's.
    expect(w.photoCards()[0]!.card).toMatchObject({ fromName: 'Sarah' });
    expect(JSON.stringify(w.photoCards())).not.toMatch(/evil\.example|Patel|doctor/);
    expect(await (await list(w.h, priya)).json()).toEqual({ photos: [] });
  });

  it('an Idempotency-Key names a picture only within the sender’s own home', async () => {
    const w = await home();
    const priya = await linkNewOrganiser(w.h, PRIYA, 'Asha');
    await residentAllows(w.h, priya.householdId, priya.userId);
    w.h.store.addTelevision(priya.householdId, { deviceId: 'tv-2', pairedAt: 5, connected: true });
    const headers = { 'content-type': 'image/jpeg', 'idempotency-key': 'same-key' };

    await send(w.h, w.sarah, jpeg(600, 1), headers);
    const res = await send(w.h, priya, jpeg(600, 9), headers);

    // Not "in use": in another home it is another picture altogether.
    expect(res.status).toBe(200);
    expect([...w.bucket.objects.keys()].sort()).toEqual([`photos/${w.sarah.householdId}/same-key.jpg`, `photos/${priya.householdId}/same-key.jpg`].sort());
    expect(w.photoCards().map((card) => card.card.householdId).sort()).toEqual([w.sarah.householdId, priya.householdId].sort());
  });

  it('there is no route that takes a household, a picture or a key in its address', async () => {
    const w = await home();
    const sent = (await (await send(w.h, w.sarah, jpeg())).json()) as { photoId: string };

    for (const path of [`/api/photos/${sent.photoId}`, `/api/photos/${w.sarah.householdId}`, `/api/households/${w.sarah.householdId}/photos`, `/api/photos/${sent.photoId}/url`]) {
      expect((await list(w.h, w.sarah, path)).status, path).toBe(404);
      expect((await send(w.h, w.sarah, jpeg(), { 'content-type': 'image/jpeg' }, path)).status, path).toBe(404);
      expect((await fetch(`${w.h.base}${path}`, { method: 'DELETE', headers: { authorization: `Bearer ${w.sarah.tokens.access_token}` } })).status, path).toBe(404);
    }
  });
});

describe('GET /api/photos — how the member’s own pictures stand', () => {
  /** What her press on the card does (the edge): either button marks the picture seen; "Keep it" also puts it on her mantelpiece. */
  const residentPresses = (w: World, householdId: string, photoId: string, action: 'keep' | 'thanks') => {
    const row = w.photoRows(householdId).find((held) => held.sk?.S === `PHOTO#${photoId}`)!;
    w.table.put({ ...row, seenAt: { N: String(Date.now()) } } as never);
    if (action === 'keep') w.table.put({ pk: { S: `HH#${householdId}` }, sk: { S: `MANTEL#${photoId}` }, photoId: { S: photoId }, keptAt: { N: String(Date.now()) } });
  };

  it('lists them newest first: waiting, and then seen — whichever button she pressed', async () => {
    const w = await home();
    const before = Date.now();
    await send(w.h, w.sarah, jpeg(), { 'content-type': 'image/jpeg', 'idempotency-key': 'kept' });
    await send(w.h, w.sarah, jpeg(), { 'content-type': 'image/jpeg', 'idempotency-key': 'thanked' });
    await send(w.h, w.sarah, jpeg(), { 'content-type': 'image/jpeg', 'idempotency-key': 'waiting' });
    residentPresses(w, w.sarah.householdId, 'kept', 'keep');
    residentPresses(w, w.sarah.householdId, 'thanked', 'thanks');

    const res = await list(w.h, w.sarah);

    expect(res.status).toBe(200);
    const { photos } = (await res.json()) as { photos: { photoId: string; sentAt: number; seen: boolean; say: string }[] };
    expect(photos.map(({ sentAt: _at, ...rest }) => rest).sort((a, b) => a.photoId.localeCompare(b.photoId))).toEqual([
      { photoId: 'kept', seen: true, say: 'Margaret has seen your picture.' },
      { photoId: 'thanked', seen: true, say: 'Margaret has seen your picture.' },
      { photoId: 'waiting', seen: false, say: 'It is waiting on Margaret’s television.' },
    ]);
    expect(photos.every((photo) => photo.sentAt >= before)).toBe(true);
    expect([...photos].sort((a, b) => b.sentAt - a.sentAt).map((photo) => photo.sentAt)).toEqual(photos.map((photo) => photo.sentAt));
    // Nothing in the answer but those four things: not when she saw it, not what she did with it, not where it is.
    for (const photo of photos) expect(Object.keys(photo).sort()).toEqual(['photoId', 'say', 'seen', 'sentAt']);
    expect(JSON.stringify(photos)).not.toMatch(/kept"?:|mantel|https?:|\.jpg|seenAt/i);
  });

  it('shows nobody another member’s pictures — the organiser no more than anyone', async () => {
    const w = await home();
    const tom = await linkInvited(w.h, TOM, await invite(w.h, w.sarah));
    await residentAllows(w.h, tom.householdId, tom.userId);
    await send(w.h, tom, jpeg(), { 'content-type': 'image/jpeg', 'idempotency-key': 'toms' });
    await send(w.h, w.sarah, jpeg(), { 'content-type': 'image/jpeg', 'idempotency-key': 'sarahs' });

    const ids = async (who: Who, path?: string) => ((await (await list(w.h, who, path)).json()) as { photos: { photoId: string }[] }).photos.map((photo) => photo.photoId);

    expect(await ids(w.sarah)).toEqual(['sarahs']);
    expect(await ids(tom)).toEqual(['toms']);
    // And nothing in a request reaches somebody else's.
    expect(await ids(w.sarah, `/api/photos?userId=${tom.userId}&sentBy=${tom.userId}&all=1`)).toEqual(['sarahs']);
  });

  it('the demo home — a guest she has allowed sends and lists like anyone', async () => {
    const w = await server({ demoAccounts: true });
    const browser = new Browser(w.h.base);
    const client = await registerClient(w.h.base);
    const tx = await beginAuthorize(browser, client, { demo: '1' });
    const landed = await browser.get(`/account?tx=${tx}`);
    const code = new URL(landed.headers.get('location')!).searchParams.get('code')!;
    const guest = { tokens: (await (await exchangeCode(w.h.base, client, code)).json()) as Tokens };
    const me = (await (await fetch(`${w.h.base}/api/me`, { headers: { authorization: `Bearer ${guest.tokens.access_token}` } })).json()) as { user: { userId: string }; household: { householdId: string } };
    w.h.store.addTelevision(me.household.householdId, { deviceId: 'virtual-tv', pairedAt: 5, connected: true });

    // Until the virtual television's Allow is pressed, nothing — INV-9 holds for a guest as for anyone.
    expect((await send(w.h, guest, jpeg())).status).toBe(403);
    await residentAllows(w.h, me.household.householdId, me.user.userId);

    expect((await send(w.h, guest, jpeg())).status).toBe(200);
    expect(w.photoCards()[0]!.card).toMatchObject({ householdId: me.household.householdId, headline: 'A picture from Guest.' });
    expect(((await (await list(w.h, guest)).json()) as { photos: unknown[] }).photos).toHaveLength(1);
  });
});

describe('the rest of the server is as it was', () => {
  it('still reads JSON where JSON is sent, and never takes a picture’s bytes for it', async () => {
    const w = await home();

    const invitation = await fetch(`${w.h.base}/api/circle/invitations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${w.sarah.tokens.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'neighbour' }),
    });
    expect(await invitation.json()).toMatchObject({ role: 'neighbour' });

    // A JPEG posted to a route that takes JSON is not parsed into anything.
    const elsewhere = await send(w.h, w.sarah, jpeg(), { 'content-type': 'image/jpeg' }, '/api/circle/invitations');
    expect(elsewhere.status).toBe(201);
    expect(await elsewhere.json()).toMatchObject({ role: 'family' });
  });
});
