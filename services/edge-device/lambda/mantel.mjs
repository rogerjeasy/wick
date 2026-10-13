/**
 * The mantelpiece, the television's half
 * (packages/contracts/src/mantel.ts).
 *
 * Someone in the family sends a picture; it reaches her television as a
 * card with two answers, "Keep it" and "Thank you". What she keeps is on
 * her mantelpiece, which she opens from the home screen and can take things
 * down from. This file is her side of all of it: what her two presses do,
 * what her mantelpiece holds, and the address a picture is shown from.
 *
 * THE RULE is the contract's, and everything here is built to keep it:
 * what she keeps is hers, and so is what she does not.
 *
 *   - The family is told one thing, whichever she pressed: that she has
 *     seen it. So both presses make the same one write to the picture's own
 *     row (`seenUpdate`, which takes no answer), and nothing else that a
 *     family tool reads tells them apart: the card is finished the same
 *     way, and the press goes on the timeline without its button
 *     (device-event.mjs).
 *   - What is on her mantelpiece is in rows only her own televisions read
 *     (`MANTEL#<photoId>`, and the count beside them), and the home screen
 *     is told a number and nothing else (light.mjs homeState).
 *   - A picture's address is minted for the television that is being
 *     answered, lives an hour, and is written nowhere (`pictureAddress`,
 *     presign.mjs): not in a row, not on the bus, not in a log.
 *
 * Keeping is one write or nothing. `keepWrite` is a single transaction
 * that answers the card, puts the picture on the mantelpiece and counts
 * it — each on a condition:
 *
 *   - the card is still waiting for its answer, so a "Thank you" on another
 *     television and a "Keep it" on this one cannot both count;
 *   - the picture is not there already;
 *   - there is room — and the room is decided where the count is kept
 *     (`MANTEL`, one row), not from a count read a moment before, so two
 *     different pictures kept at the same instant cannot both take the last
 *     place. Nothing leaves a mantelpiece by itself: when it is full the
 *     card stays, saying so, until she takes one down.
 *
 * Taking down marks the row and gives its place back, in one write. The
 * row is not deleted here: the edge's roles hold no DeleteItem — a grant
 * that cannot be narrowed to these rows, and would let a television-facing
 * function delete any row of the household — so it is given a day to live
 * and the table clears it away (`ttl`). Everything that reads the
 * mantelpiece leaves a taken-down row out.
 *
 * This plain .mjs Lambda can't import TS; the names below are inlined from
 * packages/contracts/src/mantel.ts, and mantel.test.ts holds them to it.
 *
 * Pure: device-event.mjs owns the clients.
 */
import { credentialsFromEnv, presignGet } from './presign.mjs';

export const PHOTO_SK_PREFIX = 'PHOTO#';
export const MANTEL_SK_PREFIX = 'MANTEL#';
/** The row that counts what is on her mantelpiece. Beside the things themselves, and not one of them. */
export const MANTEL_COUNT_SK = 'MANTEL';
export const MAX_MANTEL = 12;
export const MANTEL_URL_TTL_SEC = 3600;
export const PHOTO_ACTIONS = { keep: 'keep', thanks: 'thanks' };
export const MANTEL_FULL_NOTICE = 'Your mantelpiece is full. Take one down, then you can keep this.';

/** How long a taken-down row stays before the table clears it away. */
const DOWN_ROW_LIVES_SEC = 24 * 60 * 60;

const PHOTO_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CARD_PREFIX = 'photo-';

export const isPhotoId = (value) => typeof value === 'string' && PHOTO_ID.test(value);

/** Which picture a card is about (contracts photoIdOfCardId). */
export function photoIdOfCardId(cardId) {
  if (typeof cardId !== 'string' || !cardId.startsWith(CARD_PREFIX)) return undefined;
  const photoId = cardId.slice(CARD_PREFIX.length);
  return isPhotoId(photoId) ? photoId : undefined;
}

/** Where a picture's bytes are (contracts photoObjectKey). */
export const photoObjectKey = (householdId, photoId) => `photos/${householdId}/${photoId}.jpg`;

const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || 'Someone';
const household = (householdId) => ({ S: `HH#${householdId}` });
const cardKey = (householdId, photoId) => ({ pk: household(householdId), sk: { S: `CARD#${CARD_PREFIX}${photoId}` } });
const mantelKey = (householdId, photoId) => ({ pk: household(householdId), sk: { S: `${MANTEL_SK_PREFIX}${photoId}` } });
const countKey = (householdId) => ({ pk: household(householdId), sk: { S: MANTEL_COUNT_SK } });

/** GetItem key of a picture's stored card. */
export const photoCardKey = cardKey;

/** Her press on a picture's card: which picture, and which of the two answers — or undefined for any other card or press. */
export function photoPress(cardId, action) {
  const photoId = photoIdOfCardId(cardId);
  if (!photoId) return undefined;
  if (action !== PHOTO_ACTIONS.keep && action !== PHOTO_ACTIONS.thanks) return undefined;
  return { photoId, answer: action };
}

/**
 * The picture's card as the server stored it — the only place the sender's
 * name is taken from, and what says whether it has had its answer. Undefined
 * when there is no such card: a press can only answer a picture that was sent.
 */
export function storedPhotoCard(item, photoId) {
  const raw = item?.data?.S;
  if (!raw) return undefined;
  let queued;
  try {
    queued = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (queued?.card?.type !== 'PHOTO' || queued.card.photoId !== photoId) return undefined;
  return { queued, fromName: firstName(queued.card.fromName), answered: Boolean(item.actedAt) };
}

/**
 * The card as it goes back to the television that pressed "Keep it" when
 * it was not put away: there was no room (`full`, and the card says so), or
 * the keeping failed (and it says nothing: her press is not swallowed, and
 * she is told nothing untrue). The television takes a card off at a press,
 * so it has to be sent again. It answers a press, so it is shown at once
 * and not counted as another showing (`respondsTo`, as a page of "What
 * Sarah sees" is). Sent, never stored: the stored card is as it was.
 */
export function cardBack(queued, { full }) {
  // Neither an address nor an earlier notice goes back with it.
  const card = Object.fromEntries(Object.entries(queued.card).filter(([name]) => name !== 'photoUrl' && name !== 'notice'));
  return { ...queued, shownCount: 0, respondsTo: queued.id, card: full ? { ...card, notice: MANTEL_FULL_NOTICE } : card };
}

/** GetItem key of the row that counts her mantelpiece. */
export const mantelCountKey = (householdId) => countKey(householdId);

/**
 * Whether there is room, from the count's row. Only a first look — it
 * saves a full mantelpiece a write that would be refused. What decides is
 * the condition in `keepWrite`.
 */
export function mantelRoom(countItem) {
  const count = Number(countItem?.count?.N ?? 0);
  return !(count >= MAX_MANTEL);
}

/**
 * What is on her mantelpiece, from the home's rows (light.mjs homeRange
 * brings them): oldest first. A thing she took down is not on it, and
 * neither is the row that counts.
 */
export function mantelOf(items) {
  return (items ?? [])
    .filter((item) => item.sk?.S?.startsWith(MANTEL_SK_PREFIX) && !item.downAt)
    .map((item) => ({ photoId: item.sk.S.slice(MANTEL_SK_PREFIX.length), fromName: firstName(item.fromName?.S), keptAt: Number(item.keptAt?.N) }))
    .filter((thing) => isPhotoId(thing.photoId) && Number.isFinite(thing.keptAt) && thing.keptAt > 0)
    .sort((a, b) => a.keptAt - b.keptAt || (a.photoId < b.photoId ? -1 : 1))
    .slice(0, MAX_MANTEL);
}

/**
 * The mantelpiece as her television is handed it (contracts MantelItem):
 * each thing with an address minted for this asking. A thing no address
 * could be minted for is left out — a frame with nothing in it is not shown.
 */
export function mantelItems(items, addressOf) {
  return mantelOf(items).flatMap((thing) => {
    const url = addressOf(thing.photoId);
    return typeof url === 'string' && url ? [{ ...thing, url }] : [];
  });
}

/**
 * An address for one picture of this household, good for an hour — or
 * undefined when one cannot be made (no bucket configured, no credentials,
 * an id that is not a picture's). Never throws: a card goes without its
 * picture before it does not go.
 *
 * The household is the television's own, from its connection (INV-8), and
 * the id is checked: nothing in a request can name another object.
 */
export function pictureAddress({ bucket, householdId, photoId, env = process.env, now = Date.now() }) {
  if (!bucket || !householdId || !isPhotoId(photoId)) return undefined;
  const who = credentialsFromEnv(env);
  if (!who) return undefined;
  try {
    return presignGet({ bucket, key: photoObjectKey(householdId, photoId), region: who.region, credentials: who.credentials, expiresSec: MANTEL_URL_TTL_SEC, now });
  } catch {
    return undefined;
  }
}

/**
 * UpdateItem input saying she has seen the picture — the one thing the
 * family is told, and the same write whichever button she pressed.
 */
export function seenUpdate({ table, householdId, photoId, at }) {
  return {
    TableName: table,
    Key: { pk: household(householdId), sk: { S: `${PHOTO_SK_PREFIX}${photoId}` } },
    // The first time is the time: a later press never moves it.
    UpdateExpression: 'SET seenAt = if_not_exists(seenAt, :at)',
    // Never conjure a picture that was not sent.
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':at': { N: String(at) } },
  };
}

/** Only a card still waiting for its answer. */
const STILL_WAITING = 'attribute_exists(pk) AND attribute_not_exists(actedAt)';

/**
 * TransactWriteItems input for "Keep it": the card answered, the picture on
 * the mantelpiece, and the count — all three or none. Their order is what
 * `keepOutcome` reads a refusal by.
 */
export function keepWrite({ table, householdId, photoId, fromName, at }) {
  return {
    TransactItems: [
      {
        Update: {
          TableName: table,
          Key: cardKey(householdId, photoId),
          UpdateExpression: 'SET actedAt = :at',
          ConditionExpression: STILL_WAITING,
          ExpressionAttributeValues: { ':at': { N: String(at) } },
        },
      },
      {
        Put: {
          TableName: table,
          Item: { ...mantelKey(householdId, photoId), photoId: { S: photoId }, fromName: { S: fromName }, keptAt: { N: String(at) } },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Update: {
          TableName: table,
          Key: countKey(householdId),
          UpdateExpression: 'ADD #count :one',
          // Room is decided here, where the count is, and nowhere else.
          ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
          ExpressionAttributeNames: { '#count': 'count' },
          ExpressionAttributeValues: { ':one': { N: '1' }, ':max': { N: String(MAX_MANTEL) } },
        },
      },
    ],
  };
}

const REFUSED = 'ConditionalCheckFailed';
const IN_THE_WAY = new Set(['TransactionConflict']);

/**
 * What a keep that did not go through means:
 *   `kept`      the picture is on the mantelpiece already — kept on another
 *               television a moment before;
 *   `answered`  the card had its answer already and the picture is not
 *               there: she said thank you, on another television;
 *   `full`      there was no room;
 *   `again`     another write was in the way: try once more;
 *   `failed`    anything else.
 */
export function keepOutcome(err) {
  if (err?.name === 'TransactionInProgressException' || err?.name === 'TransactionConflictException') return 'again';
  if (err?.name !== 'TransactionCanceledException') return 'failed';
  const [card, thing, count] = (err.CancellationReasons ?? []).map((reason) => reason?.Code);
  if (thing === REFUSED) return 'kept';
  if (card === REFUSED) return 'answered';
  if (count === REFUSED) return 'full';
  if ([card, thing, count].some((code) => IN_THE_WAY.has(code))) return 'again';
  return 'failed';
}

/**
 * UpdateItem input for "Thank you": the card answered, if it still waits.
 * The same stamp any answered card carries (card-acted.mjs), claimed here on
 * a condition so that a picture kept on another television at the same
 * moment is not thanked away as well.
 */
export function thanksClaim({ table, householdId, photoId, at }) {
  return {
    TableName: table,
    Key: cardKey(householdId, photoId),
    UpdateExpression: 'SET actedAt = :at',
    ConditionExpression: STILL_WAITING,
    ExpressionAttributeValues: { ':at': { N: String(at) } },
  };
}

/**
 * TransactWriteItems input for taking one thing down: the row marked, and
 * its place given back — only if it is there. See this file's header for
 * why the row is marked and not deleted.
 */
export function takeDownWrite({ table, householdId, photoId, at }) {
  return {
    TransactItems: [
      {
        Update: {
          TableName: table,
          Key: mantelKey(householdId, photoId),
          UpdateExpression: 'SET downAt = :at, #ttl = :ttl',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(downAt)',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':at': { N: String(at) }, ':ttl': { N: String(Math.floor(at / 1000) + DOWN_ROW_LIVES_SEC) } },
        },
      },
      {
        Update: {
          TableName: table,
          Key: countKey(householdId),
          UpdateExpression: 'ADD #count :less',
          ConditionExpression: '#count > :none',
          ExpressionAttributeNames: { '#count': 'count' },
          ExpressionAttributeValues: { ':less': { N: '-1' }, ':none': { N: '0' } },
        },
      },
    ],
  };
}

/**
 * What S3 is told of a picture, for the bucket's own rules to act on
 * (infra/photos.tf): `sent` — not answered yet, kept four hundred days; `kept` —
 * for good; `gone` — a day. The server writes `sent` when it uploads; the
 * edge writes it only to put a picture back as it was when a keeping did
 * not go through after all.
 */
export const PHOTO_STATES = { sent: 'sent', kept: 'kept', gone: 'gone' };
/** The tag's name (contracts PHOTO_STATE_TAG): the one the bucket's rules are written in. */
export const PHOTO_STATE_TAG = 'state';

/** PutObjectTagging input: the picture's one tag, replaced. */
export function retagInput({ bucket, householdId, photoId, state }) {
  if (!Object.values(PHOTO_STATES).includes(state)) throw new Error(`${state} is not a state a picture has`);
  return { Bucket: bucket, Key: photoObjectKey(householdId, photoId), Tagging: { TagSet: [{ Key: PHOTO_STATE_TAG, Value: state }] } };
}

/**
 * Whether S3 refused because the object is not there: the bucket let go of
 * the picture before she answered. Not a failure to try again — there is
 * nothing to tag, and never will be.
 */
export function isMissingObject(err) {
  return err?.name === 'NoSuchKey' || err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404;
}
