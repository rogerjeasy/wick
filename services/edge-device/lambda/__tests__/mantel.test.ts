import { describe, expect, it } from 'vitest';
import {
  MANTEL_FULL_NOTICE as CONTRACT_FULL_NOTICE,
  MANTEL_SK_PREFIX as CONTRACT_MANTEL_PREFIX,
  MANTEL_URL_TTL_SEC as CONTRACT_URL_TTL,
  MAX_MANTEL as CONTRACT_MAX,
  PHOTO_ACTIONS as CONTRACT_ACTIONS,
  PHOTO_SK_PREFIX as CONTRACT_PHOTO_PREFIX,
  PHOTO_STATES as CONTRACT_STATES,
  PHOTO_STATE_TAG as CONTRACT_STATE_TAG,
  isPhotoId as contractIsPhotoId,
  photoCardId,
  photoIdOfCardId as contractPhotoIdOfCardId,
  photoObjectKey as contractPhotoObjectKey,
  readHomeState,
  readMantelItems,
} from '@wick/contracts';
import {
  MANTEL_COUNT_SK,
  MANTEL_FULL_NOTICE,
  MANTEL_SK_PREFIX,
  MANTEL_URL_TTL_SEC,
  MAX_MANTEL,
  PHOTO_STATES,
  PHOTO_ACTIONS,
  PHOTO_SK_PREFIX,
  PHOTO_STATE_TAG,
  cardBack,
  isMissingObject,
  isPhotoId,
  keepOutcome,
  keepWrite,
  mantelCountKey,
  mantelItems,
  mantelOf,
  mantelRoom,
  photoIdOfCardId,
  photoObjectKey,
  photoPress,
  pictureAddress,
  retagInput,
  seenUpdate,
  storedPhotoCard,
  takeDownWrite,
  thanksClaim,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../mantel.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { buildHomeChangedEntry, homeRange, homeState } from '../light.mjs';

const HH = 'HH#hh-1';
const kept = (photoId: string, keptAt: number, extra: Record<string, unknown> = {}) => ({ pk: { S: HH }, sk: { S: `MANTEL#${photoId}` }, photoId: { S: photoId }, fromName: { S: 'Sarah' }, keptAt: { N: String(keptAt) }, ...extra });

describe('held to the contract', () => {
  it('names the same rows, the same buttons, the same limit, the same lifetime and the same words', () => {
    expect(PHOTO_SK_PREFIX).toBe(CONTRACT_PHOTO_PREFIX);
    expect(MANTEL_SK_PREFIX).toBe(CONTRACT_MANTEL_PREFIX);
    expect(PHOTO_ACTIONS).toEqual(CONTRACT_ACTIONS);
    expect(MAX_MANTEL).toBe(CONTRACT_MAX);
    expect(MANTEL_URL_TTL_SEC).toBe(CONTRACT_URL_TTL);
    expect(MANTEL_FULL_NOTICE).toBe(CONTRACT_FULL_NOTICE);
  });

  it('tells the bucket what a picture is in the contract’s own tag and words — the ones its lifecycle rules are written in', () => {
    expect(PHOTO_STATE_TAG).toBe(CONTRACT_STATE_TAG);
    expect(PHOTO_STATES).toEqual(CONTRACT_STATES);
    for (const state of Object.values(CONTRACT_STATES)) {
      expect(retagInput({ bucket: 'b', householdId: 'hh-1', photoId: 'p1', state }).Tagging).toEqual({ TagSet: [{ Key: CONTRACT_STATE_TAG, Value: state }] });
    }
  });

  it('knows a picture’s id, its card and where its bytes are exactly as the contract does', () => {
    for (const id of ['p1', 'A-b_9', 'x'.repeat(64), 'x'.repeat(65), '', 'a/b', '../x', 'a b', 'a.jpg', 7, undefined, null]) {
      expect(isPhotoId(id)).toBe(contractIsPhotoId(id));
    }
    for (const cardId of [photoCardId('p1'), photoCardId('A-b_9'), 'photo-', 'photo-a/b', 'photo-../../x', 'note-1', 'circle-p1', '', 7, undefined]) {
      expect(photoIdOfCardId(cardId)).toBe(contractPhotoIdOfCardId(cardId));
    }
    expect(photoObjectKey('hh-1', 'p1')).toBe(contractPhotoObjectKey('hh-1', 'p1'));
  });

  it('keeps its own count in a row the home screen’s one read brings, beside what she kept — and a picture’s own row is outside it', () => {
    const { ':from': from, ':to': to } = homeRange({ table: 'wick', householdId: 'hh-1' }).ExpressionAttributeValues;
    const inRange = (sk: string) => sk >= from.S && sk <= to.S;

    expect(inRange(MANTEL_COUNT_SK)).toBe(true);
    expect(inRange(`${MANTEL_SK_PREFIX}p1`)).toBe(true);
    expect(inRange(`${MANTEL_SK_PREFIX}${'z'.repeat(64)}`)).toBe(true);
    expect(inRange(`${PHOTO_SK_PREFIX}p1`)).toBe(false);
    // The count's row is not one of the things on the mantelpiece.
    expect(MANTEL_COUNT_SK.startsWith(MANTEL_SK_PREFIX)).toBe(false);
  });
});

describe('photoPress — her answer, read from the card id alone', () => {
  it('is keep or thanks for the picture the card is about', () => {
    expect(photoPress('photo-p1', 'keep')).toEqual({ photoId: 'p1', answer: 'keep' });
    expect(photoPress('photo-p1', 'thanks')).toEqual({ photoId: 'p1', answer: 'thanks' });
  });

  it('is nothing for any other card, any other press, or an id that is not a picture’s', () => {
    for (const [cardId, action] of [['note-1', 'keep'], ['photo-p1', 'dismiss'], ['photo-p1', 'toString'], ['photo-a/b', 'keep'], ['photo-', 'thanks'], ['photo-p1', undefined]] as const) {
      expect(photoPress(cardId, action)).toBeUndefined();
    }
  });
});

describe('mantelOf — what is on her mantelpiece, from the home’s rows', () => {
  it('is what she kept, oldest first, by the sender’s first name', () => {
    const rows = [kept('b', 300), { pk: { S: HH }, sk: { S: 'META' } }, kept('a', 100, { fromName: { S: 'Tom Hughes' } }), kept('c', 200)];

    expect(mantelOf(rows)).toEqual([
      { photoId: 'a', fromName: 'Tom', keptAt: 100 },
      { photoId: 'c', fromName: 'Sarah', keptAt: 200 },
      { photoId: 'b', fromName: 'Sarah', keptAt: 300 },
    ]);
  });

  it('leaves out what she took down, the count’s own row, and anything that is not a kept picture', () => {
    const rows = [
      kept('a', 100),
      kept('down', 150, { downAt: { N: '900' }, ttl: { N: '99' } }),
      { pk: { S: HH }, sk: { S: MANTEL_COUNT_SK }, count: { N: '1' } },
      { pk: { S: HH }, sk: { S: 'MANTEL#bad id' }, keptAt: { N: '5' } },
      { pk: { S: HH }, sk: { S: 'MANTEL#nokept' } },
      { pk: { S: HH }, sk: { S: 'MEM#u1' }, keptAt: { N: '5' } },
    ];

    expect(mantelOf(rows).map((item: { photoId: string }) => item.photoId)).toEqual(['a']);
  });

  it('never holds more than a mantelpiece does', () => {
    const rows = Array.from({ length: MAX_MANTEL + 3 }, (_, i) => kept(`p${i}`, 100 + i));

    expect(mantelOf(rows)).toHaveLength(MAX_MANTEL);
  });
});

describe('mantelItems — the mantelpiece as her television is handed it', () => {
  it('gives each thing an address minted for this asking, in a shape the television’s own reader keeps whole', () => {
    const items = mantelItems([kept('a', 100), kept('b', 200)], (photoId: string) => `https://photos.example/${photoId}?sig=1`);

    expect(items).toEqual([
      { photoId: 'a', fromName: 'Sarah', keptAt: 100, url: 'https://photos.example/a?sig=1' },
      { photoId: 'b', fromName: 'Sarah', keptAt: 200, url: 'https://photos.example/b?sig=1' },
    ]);
    expect(readMantelItems(items)).toEqual(items);
  });

  it('leaves out a thing it cannot mint an address for: a frame with nothing in it is not shown', () => {
    expect(mantelItems([kept('a', 100), kept('b', 200)], (photoId: string) => (photoId === 'a' ? undefined : 'https://photos.example/b'))).toEqual([
      { photoId: 'b', fromName: 'Sarah', keptAt: 200, url: 'https://photos.example/b' },
    ]);
  });
});

describe('pictureAddress — an address for one picture of this household', () => {
  const env = { AWS_ACCESS_KEY_ID: 'ASIA1', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 'tok', AWS_REGION: 'us-east-1' };
  const mint = (over: Record<string, unknown> = {}) => pictureAddress({ bucket: 'wick-photos-1', householdId: 'hh-1', photoId: 'p1', env, now: Date.UTC(2026, 9, 13), ...over });

  it('is a presigned GET for the picture’s own object, good for an hour', () => {
    const url = new URL(mint());

    expect(url.host).toBe('wick-photos-1.s3.us-east-1.amazonaws.com');
    expect(url.pathname).toBe('/photos/hh-1/p1.jpg');
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(CONTRACT_URL_TTL));
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('tok');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is nothing — never an error — without a bucket, without credentials, or for an id that is not a picture’s', () => {
    expect(mint({ bucket: undefined })).toBeUndefined();
    expect(mint({ bucket: '' })).toBeUndefined();
    expect(mint({ env: {} })).toBeUndefined();
    expect(mint({ photoId: '../../other/secret' })).toBeUndefined();
    expect(mint({ photoId: undefined })).toBeUndefined();
  });
});

describe('storedPhotoCard — the card as the server stored it', () => {
  const queued = { id: 'photo-p1', urgency: 'DEFERRED', queuedAt: 1, shownCount: 0, card: { type: 'PHOTO', id: 'photo-p1', photoId: 'p1', fromName: 'Sarah Hughes', headline: 'A picture from Sarah.', actions: [] } };
  const row = (extra: Record<string, unknown> = {}, card: object = queued) => ({ pk: { S: HH }, sk: { S: 'CARD#photo-p1' }, data: { S: JSON.stringify(card) }, ...extra });

  it('is the card, still to be answered, with the sender’s first name', () => {
    expect(storedPhotoCard(row(), 'p1')).toEqual({ queued, fromName: 'Sarah', answered: false });
  });

  it('says so when it has been answered already', () => {
    expect(storedPhotoCard(row({ actedAt: { N: '5' } }), 'p1')).toMatchObject({ answered: true });
  });

  it('is nothing when there is no such card, when it is not a picture’s, or when it is about another picture', () => {
    expect(storedPhotoCard(undefined, 'p1')).toBeUndefined();
    expect(storedPhotoCard({ pk: { S: HH }, sk: { S: 'CARD#photo-p1' } }, 'p1')).toBeUndefined();
    expect(storedPhotoCard(row({}, { ...queued, card: { ...queued.card, type: 'MESSAGE' } }), 'p1')).toBeUndefined();
    expect(storedPhotoCard(row({}, { ...queued, card: { ...queued.card, photoId: 'p2' } }), 'p1')).toBeUndefined();
    expect(storedPhotoCard(row({ data: { S: 'not json' } }), 'p1')).toBeUndefined();
  });
});

describe('cardBack — the card as it goes back to the television that pressed, when it was not put away', () => {
  const queued = { id: 'photo-p1', urgency: 'DEFERRED', queuedAt: 1, shownCount: 2, card: { type: 'PHOTO', id: 'photo-p1', photoId: 'p1', fromName: 'Sarah', headline: 'A picture from Sarah.', actions: [], photoUrl: 'https://old.example/x' } };

  it('says the mantelpiece is full, answers her press at once, and carries no address of its own', () => {
    const back = cardBack(queued, { full: true });

    expect(back.card.notice).toBe(CONTRACT_FULL_NOTICE);
    // It answers a press: shown now, like the page "What Sarah sees" turns to — not counted as a third showing.
    expect(back.respondsTo).toBe('photo-p1');
    expect(back.shownCount).toBe(0);
    expect(back.card.photoUrl).toBeUndefined();
    expect(back.card).toMatchObject({ type: 'PHOTO', id: 'photo-p1', photoId: 'p1', headline: 'A picture from Sarah.' });
  });

  it('goes back without a word when the keeping simply failed: her press is not swallowed, and she is told nothing untrue', () => {
    const back = cardBack(queued, { full: false });

    expect(back.card).not.toHaveProperty('notice');
    expect(back.respondsTo).toBe('photo-p1');
    expect(back.shownCount).toBe(0);
  });

  it('leaves the stored card as it was', () => {
    cardBack(queued, { full: true });

    expect(queued.card).not.toHaveProperty('notice');
    expect(queued.shownCount).toBe(2);
  });
});

describe('mantelRoom — whether there is room, from the count’s own row', () => {
  it('reads the row that counts, by its key', () => {
    expect(mantelCountKey('hh-1')).toEqual({ pk: { S: HH }, sk: { S: MANTEL_COUNT_SK } });
  });

  it('is room below the limit, and none at it', () => {
    expect(mantelRoom(undefined)).toBe(true);
    expect(mantelRoom({ count: { N: '0' } })).toBe(true);
    expect(mantelRoom({ count: { N: String(CONTRACT_MAX - 1) } })).toBe(true);
    expect(mantelRoom({ count: { N: String(CONTRACT_MAX) } })).toBe(false);
    expect(mantelRoom({ count: { N: String(CONTRACT_MAX + 1) } })).toBe(false);
  });
});

describe('seenUpdate — the one thing the family is told', () => {
  const update = seenUpdate({ table: 'wick', householdId: 'hh-1', photoId: 'p1', at: 500 });

  it('stamps the picture’s own row the first time, and never moves it', () => {
    expect(update).toEqual({
      TableName: 'wick',
      Key: { pk: { S: HH }, sk: { S: 'PHOTO#p1' } },
      UpdateExpression: 'SET seenAt = if_not_exists(seenAt, :at)',
      // Never conjure a picture that was not sent.
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':at': { N: '500' } },
    });
  });

  it('is the same write whichever button she pressed: it takes no answer', () => {
    expect(JSON.stringify(update)).not.toMatch(/keep|thanks|kept|mantel/i);
  });
});

describe('keepWrite — keeping a picture is one write, or it is nothing', () => {
  const write = keepWrite({ table: 'wick', householdId: 'hh-1', photoId: 'p1', fromName: 'Sarah', at: 700 });
  const [claim, put, count] = write.TransactItems;

  it('answers the card, puts the picture on the mantelpiece and counts it — all three, together', () => {
    expect(write.TransactItems).toHaveLength(3);
    expect(claim.Update).toMatchObject({ TableName: 'wick', Key: { pk: { S: HH }, sk: { S: 'CARD#photo-p1' } }, UpdateExpression: 'SET actedAt = :at' });
    expect(put.Put.Item).toEqual({ pk: { S: HH }, sk: { S: 'MANTEL#p1' }, photoId: { S: 'p1' }, fromName: { S: 'Sarah' }, keptAt: { N: '700' } });
    expect(count.Update).toMatchObject({ Key: { pk: { S: HH }, sk: { S: MANTEL_COUNT_SK } }, UpdateExpression: 'ADD #count :one' });
  });

  it('only for a card still waiting for its answer: a "Thank you" on another television cannot be kept over', () => {
    expect(claim.Update.ConditionExpression).toBe('attribute_exists(pk) AND attribute_not_exists(actedAt)');
  });

  it('only once', () => {
    expect(put.Put.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  it('only while there is room — decided where the count is kept, so two pictures kept at the same moment cannot both take the last place', () => {
    expect(count.Update.ConditionExpression).toBe('attribute_not_exists(#count) OR #count < :max');
    expect(count.Update.ExpressionAttributeValues).toEqual({ ':one': { N: '1' }, ':max': { N: String(CONTRACT_MAX) } });
  });
});

describe('keepOutcome — what a keep that did not go through means', () => {
  const cancelled = (...codes: string[]) => Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException', CancellationReasons: codes.map((Code) => ({ Code })) });

  it('is "full" when only the count refused', () => {
    expect(keepOutcome(cancelled('None', 'None', 'ConditionalCheckFailed'))).toBe('full');
  });

  it('is "answered" when the card had its answer already and the picture is not on the mantelpiece: she said thank you, on another television', () => {
    expect(keepOutcome(cancelled('ConditionalCheckFailed', 'None', 'None'))).toBe('answered');
    expect(keepOutcome(cancelled('ConditionalCheckFailed', 'None', 'ConditionalCheckFailed'))).toBe('answered');
  });

  it('is "kept" when it is on the mantelpiece already — kept on another television a moment before', () => {
    expect(keepOutcome(cancelled('None', 'ConditionalCheckFailed', 'None'))).toBe('kept');
    expect(keepOutcome(cancelled('ConditionalCheckFailed', 'ConditionalCheckFailed', 'ConditionalCheckFailed'))).toBe('kept');
  });

  it('is "again" when another write was in the way, and "failed" for anything else', () => {
    expect(keepOutcome(cancelled('None', 'None', 'TransactionConflict'))).toBe('again');
    expect(keepOutcome(Object.assign(new Error('busy'), { name: 'TransactionInProgressException' }))).toBe('again');
    expect(keepOutcome(new Error('down'))).toBe('failed');
    expect(keepOutcome(cancelled('ThrottlingError', 'None', 'None'))).toBe('failed');
  });
});

describe('thanksClaim — "Thank you" answers the card, once', () => {
  it('stamps the card only if it is still waiting: a picture kept on another television is not thanked away', () => {
    expect(thanksClaim({ table: 'wick', householdId: 'hh-1', photoId: 'p1', at: 800 })).toEqual({
      TableName: 'wick',
      Key: { pk: { S: HH }, sk: { S: 'CARD#photo-p1' } },
      UpdateExpression: 'SET actedAt = :at',
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(actedAt)',
      ExpressionAttributeValues: { ':at': { N: '800' } },
    });
  });
});

describe('takeDownWrite — taking one thing down', () => {
  const write = takeDownWrite({ table: 'wick', householdId: 'hh-1', photoId: 'p1', at: 1_000_000 });
  const [down, count] = write.TransactItems;

  it('marks it taken down — only if it is there — and lets the table clear the row away a day on: the edge deletes nothing', () => {
    expect(down.Update).toEqual({
      TableName: 'wick',
      Key: { pk: { S: HH }, sk: { S: 'MANTEL#p1' } },
      UpdateExpression: 'SET downAt = :at, #ttl = :ttl',
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(downAt)',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':at': { N: '1000000' }, ':ttl': { N: String(1000 + 24 * 60 * 60) } },
    });
    expect(JSON.stringify(write)).not.toMatch(/"Delete"/);
  });

  it('gives its place back in the same write', () => {
    expect(count.Update).toMatchObject({
      Key: { pk: { S: HH }, sk: { S: MANTEL_COUNT_SK } },
      UpdateExpression: 'ADD #count :less',
      ConditionExpression: '#count > :none',
      ExpressionAttributeValues: { ':less': { N: '-1' }, ':none': { N: '0' } },
    });
  });
});

describe('what S3 is told of a picture — so that the bucket keeps what she kept and lets go of what she did not', () => {
  it('replaces the picture’s one tag: kept for good, or gone in a day', () => {
    expect(retagInput({ bucket: 'wick-photos-1', householdId: 'hh-1', photoId: 'p1', state: PHOTO_STATES.kept })).toEqual({
      Bucket: 'wick-photos-1',
      Key: 'photos/hh-1/p1.jpg',
      Tagging: { TagSet: [{ Key: 'state', Value: 'kept' }] },
    });
    expect(retagInput({ bucket: 'wick-photos-1', householdId: 'hh-1', photoId: 'p1', state: PHOTO_STATES.gone }).Tagging).toEqual({ TagSet: [{ Key: 'state', Value: 'gone' }] });
  });

  it('can put a picture back to "sent" — as the server left it — when a keeping did not go through after all', () => {
    expect(PHOTO_STATES).toEqual({ sent: 'sent', kept: 'kept', gone: 'gone' });
    expect(retagInput({ bucket: 'b', householdId: 'hh-1', photoId: 'p1', state: PHOTO_STATES.sent }).Tagging).toEqual({ TagSet: [{ Key: 'state', Value: 'sent' }] });
  });

  it('gives a picture no state the bucket’s rules do not know', () => {
    expect(() => retagInput({ bucket: 'b', householdId: 'hh-1', photoId: 'p1', state: 'archived' })).toThrow();
    expect(() => retagInput({ bucket: 'b', householdId: 'hh-1', photoId: 'p1', state: undefined })).toThrow();
  });
});

describe('isMissingObject — a picture that is not there, told apart from a refusal', () => {
  /**
   * S3 only says "not found" to a caller that may list the bucket; to one
   * that may not, a missing object and a forbidden one both answer 403. The
   * edge's roles are given that listing on the pictures' bucket for exactly
   * this (infra/photos.tf, `TellAMissingPictureFromARefusal`) — so here a
   * 404 means the bytes are gone, and a 403 means what it says.
   */
  it('is so for S3’s "no such key", by name or by a plain 404', () => {
    expect(isMissingObject({ name: 'NoSuchKey' })).toBe(true);
    expect(isMissingObject({ name: 'NotFound' })).toBe(true);
    expect(isMissingObject({ name: 'UnknownError', $metadata: { httpStatusCode: 404 } })).toBe(true);
  });

  it('is never so for a refusal: a 403 is not "gone", and must not finish a card over a picture that is still there', () => {
    expect(isMissingObject({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })).toBe(false);
    expect(isMissingObject({ name: 'Forbidden', $metadata: { httpStatusCode: 403 } })).toBe(false);
    expect(isMissingObject({ name: '403' })).toBe(false);
  });

  it('nor for anything else that went wrong, or nothing at all', () => {
    for (const err of [{ name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } }, { name: 'SlowDown' }, new Error('socket'), undefined, null]) {
      expect(isMissingObject(err)).toBe(false);
    }
  });
});

describe('homeState — the home screen is told how many things she has kept, and nothing of what they are', () => {
  const NOW = Date.UTC(2026, 9, 12, 9, 30);
  const meta = { pk: { S: HH }, sk: { S: 'META' } };
  const state = (items: object[]) => homeState({ items, now: NOW, timeZone: 'Europe/London' });

  it('carries the count when there is at least one', () => {
    expect(state([meta, kept('a', 1), kept('b', 2)])).toEqual({ mantel: 2 });
  });

  it('says nothing of it when there is none — an empty mantelpiece and no mantelpiece are the same home screen', () => {
    expect(state([meta])).toEqual({});
    expect(state([meta, kept('a', 1, { downAt: { N: '5' } }), { pk: { S: HH }, sk: { S: MANTEL_COUNT_SK }, count: { N: '0' } }])).toEqual({});
  });

  it('is a number and nothing else: no id, no name, no address', () => {
    const home = state([meta, kept('secretid', 1, { fromName: { S: 'Zebedee' } })]);

    expect(JSON.stringify(home)).toBe('{"mantel":1}');
  });

  it('reaches the home’s other televisions through the bus: the contract keeps it on the way', () => {
    const home = state([meta, kept('a', 1)]);
    const entry = buildHomeChangedEntry({ busName: 'wick', householdId: 'hh-1', deviceId: 'tv-1', home, at: NOW });

    expect(readHomeState(JSON.parse(entry.Detail).home)).toEqual({ mantel: 1 });
    expect(entry.Detail).not.toMatch(/https:|photoId|fromName/);
  });
});
