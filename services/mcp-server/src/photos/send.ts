/**
 * The mantelpiece, the sending (packages/contracts mantel.ts): a picture
 * from somebody in her family circle, on its way to her television.
 *
 * A picture is a file, and a model cannot hand one over — so this is not a
 * tool. It is the family app's own business with the Wick server
 * (`POST /api/photos`, photos/routes.ts), and this is what that route does.
 *
 * The checks, in the order they are made, and why in that order:
 *
 *   1. Who is sending. A member she has allowed, asked afresh on every
 *      call (INV-9), and not a neighbour. First, so that nobody else is
 *      told anything about a picture, a limit or a television — and, in
 *      the route, before a byte of the request's body is read.
 *   2. That this Wick can send pictures at all.
 *   3. That the bytes are a JPEG, by their own markers.
 *   4. Whether this very picture was sent already (the key the app made
 *      for it, INV-6). If so it is answered as it was, before anything
 *      that might have changed since — the day's count, the television —
 *      can refuse a second try at something already done.
 *   5. That her home has a television: there is nowhere to show it else.
 *   6. That the member has not sent their six today.
 *   7. That the member has not tried twenty times today (photos/tries.ts).
 *      The try is counted here, by one conditional write, immediately
 *      before the look it pays for: a refused picture leaves no row, so
 *      without this the look below could be bought without end. A second
 *      try at a picture already sent was answered at 4 and is not counted;
 *      what is refused at 1 to 6 never reaches a look and is not either.
 *   8. Moderation, last: it is the one check that costs money and takes
 *      time, and the only thing that looks at the picture. Nothing is
 *      stored before it has passed, so a picture that is refused was never
 *      written anywhere.
 *
 * Then the writes: the picture's row first, under a condition — it is the
 * claim on the id, so one id is one picture, and nobody's picture is ever
 * written over; then the picture into the bucket; then one card through
 * the sender the server was given (INV-2). The day's count is taken again
 * once the claim is made, so sendings that cross cannot add up to more
 * than six. If a later step fails the earlier ones are undone, as far as
 * they can be, and the member is told it was not sent.
 *
 * Nothing written here says where a picture's bytes are. The card and the
 * row carry its id. The address her television is given is minted on the
 * way to it, by the egress, and is written nowhere.
 *
 * The household is the one in the sender's token (INV-8). Nothing in a
 * request names a household, a key or an address; the one thing a request
 * can name is the id of its own picture, and that is used only within the
 * sender's household and only for a picture that is theirs.
 */
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { MAX_PHOTOS_A_DAY, isPhotoId, looksLikeJpeg, photoCardId, photoCardWords, type QueuedCard } from '@wick/contracts';
import { accessOf, cleanName } from '../accounts/circle.js';
import type { AccountStore } from '../accounts/store.js';
import { zoneOf, type Household, type Membership } from '../accounts/types.js';
import type { Moderation } from './moderation.js';
import type { PhotoObjects } from './objects.js';
import { claimPhoto, getPhoto, listPhotos, releasePhoto } from './rows.js';
import { countTry } from './tries.js';

export interface PhotoDeps {
  /** The household's own rows: a picture's row, and nothing else of hers. */
  readonly ddb: DynamoDBClient;
  readonly store: AccountStore;
  /** The photos bucket. Absent where the deployment has none: pictures are then refused, in words. */
  readonly objects?: PhotoObjects | undefined;
  /** The one look anything takes at a picture. Absent, pictures are refused: nothing is sent unchecked. */
  readonly moderate?: Moderation | undefined;
  /** services/agent/src/egress.ts's sendToDevice — the only path to the television (INV-2). */
  readonly sendCard: (card: QueuedCard) => Promise<void>;
  /** egress.ts's takeBackFromDevices (INV-2): how a card half sent leaves her television when a sending is undone. */
  readonly withdrawCard: (householdId: string, cardId: string) => Promise<void>;
  readonly now: () => number;
  /** A fresh, unguessable, URL-safe id. */
  readonly newId: () => string;
}


/** Who is sending: the person and the household their access token names (INV-8). Never anything from a request. */
export interface PhotoActor {
  readonly householdId: string;
  readonly userId: string;
}

export type PhotoRefusalCode =
  | 'not_allowed_yet'
  | 'not_for_a_neighbour'
  | 'photos_unavailable'
  | 'not_a_jpeg'
  | 'too_large'
  | 'bad_key'
  | 'key_in_use'
  | 'no_television'
  | 'too_many_today'
  | 'too_many_tries'
  | 'not_sendable'
  | 'not_checked'
  | 'not_sent';

/** A refusal a person can be told as it stands, with the status the route answers. */
export class PhotoRefusal extends Error {
  readonly status: number;
  readonly code: PhotoRefusalCode;
  constructor(status: number, code: PhotoRefusalCode, message: string) {
    super(message);
    this.name = 'PhotoRefusal';
    this.status = status;
    this.code = code;
  }
}

export interface PhotoSent {
  readonly sent: true;
  readonly photoId: string;
  readonly say: string;
}

export const NOT_A_JPEG = 'That is not a picture Wick can take. It needs to be a JPEG.';
/** Said for a key that cannot be this picture's: malformed, or somebody else's. Which is not told. */
const CHOOSE_AGAIN = 'That picture could not be sent. Choose it again.';

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const inWords = (n: number): string => NUMBER_WORDS[n] ?? String(n);

/** The calendar day a moment falls on where the house is. */
const dayAt = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));

/** A member she has allowed, and the household — or the refusal they are told. For the route and for the list alike. */
export interface Sender {
  readonly membership: Membership;
  readonly household: Household;
}

/**
 * INV-9's gate for pictures, asked on every call: somebody she has
 * allowed, and not a neighbour — who is asked two things and sends
 * nothing. An organiser still waiting for her is refused like anyone
 * waiting: a picture is not how she comes to allow somebody.
 */
export async function allowedSender(deps: Pick<PhotoDeps, 'store'>, actor: PhotoActor): Promise<Sender> {
  const [membership, household] = await Promise.all([
    deps.store.getMembership(actor.householdId, actor.userId),
    deps.store.getHousehold(actor.householdId),
  ]);
  // Said first, so a neighbour still waiting is not told that being allowed would change it.
  if (membership?.role === 'neighbour') throw new PhotoRefusal(403, 'not_for_a_neighbour', 'A neighbour cannot send a picture.');
  const access = accessOf(membership, household);
  if (!access.ok) throw new PhotoRefusal(403, 'not_allowed_yet', access.say);
  return access;
}

/** Refused where this Wick has no bucket, or nothing to check a picture with: nothing is ever sent unchecked. */
export function photosAvailable(deps: Pick<PhotoDeps, 'objects' | 'moderate'>): asserts deps is { objects: PhotoObjects; moderate: Moderation } {
  if (!deps.objects || !deps.moderate) throw new PhotoRefusal(503, 'photos_unavailable', 'This Wick cannot send pictures yet.');
}

/** The card she answers. Wick's own words under the name of the member she allowed; the picture's id, and nothing that finds its bytes. */
export function buildPhotoCard(household: Household, photoId: string, fromName: string, now: number): QueuedCard {
  const id = photoCardId(photoId);
  return {
    id,
    // Like a note: it waits for a natural break, and never arrives in the middle of a programme (INV-5).
    urgency: 'DEFERRED',
    queuedAt: now,
    shownCount: 0,
    card: {
      type: 'PHOTO',
      id,
      householdId: household.householdId,
      correlationId: id,
      createdAt: now,
      photoId,
      fromName,
      ...photoCardWords(fromName),
    },
  };
}

const failed = (step: string) => (err: unknown) =>
  // The step and the error's name: never the picture's id, whose it was, or a message that could carry an ARN.
  console.error(JSON.stringify({ level: 'error', msg: 'photo_not_undone', step, err: err instanceof Error ? err.name : 'unknown' }));

/**
 * Send one picture. `key` is the id the family app made for this picture
 * (the `Idempotency-Key` header), or undefined for one Wick is to name.
 */
export async function sendPhoto(deps: PhotoDeps, actor: PhotoActor, bytes: Uint8Array, key: string | undefined): Promise<PhotoSent> {
  const { membership, household } = await allowedSender(deps, actor);
  photosAvailable(deps);
  const resident = household.residentName;
  const timeZone = zoneOf(household);
  const sent = (photoId: string): PhotoSent => ({
    sent: true,
    photoId,
    say: `Your picture is on its way to ${resident}’s television. It will wait for a quiet moment.`,
  });

  if (!looksLikeJpeg(bytes)) throw new PhotoRefusal(415, 'not_a_jpeg', NOT_A_JPEG);
  // A key that is not shaped like a picture's id is refused, not ignored: sending without it would quietly give up
  // "once, however often it is tried".
  if (key !== undefined && !isPhotoId(key)) throw new PhotoRefusal(400, 'bad_key', CHOOSE_AGAIN);

  /** A picture of that id is there already: the sender's own is answered as it was; anybody else's is not theirs to send over. */
  const alreadyThere = async (photoId: string): Promise<PhotoSent | undefined> => {
    const row = await getPhoto(deps.ddb, actor.householdId, photoId);
    if (!row) return undefined;
    if (row.sentBy !== actor.userId) throw new PhotoRefusal(409, 'key_in_use', CHOOSE_AGAIN);
    return sent(photoId);
  };
  if (key !== undefined) {
    const before = await alreadyThere(key);
    if (before) return before;
  }

  // Nothing could show it to her: a picture with no television would wait for ever, and say it was on its way.
  if ((await deps.store.listTelevisions(actor.householdId)).length === 0) {
    throw new PhotoRefusal(409, 'no_television', `Connect ${resident}’s television first. There is nowhere to show her a picture yet.`);
  }

  const now = deps.now();
  const today = dayAt(now, timeZone);
  const sentToday = async (): Promise<number> =>
    (await listPhotos(deps.ddb, actor.householdId)).filter((row) => row.sentBy === actor.userId && dayAt(row.sentAt, timeZone) === today).length;
  const tooMany = () =>
    new PhotoRefusal(429, 'too_many_today', `You have sent ${resident} ${inWords(MAX_PHOTOS_A_DAY)} pictures today. You can send another tomorrow.`);
  if ((await sentToday()) >= MAX_PHOTOS_A_DAY) throw tooMany();

  // The try is counted before the look it pays for, whatever the look will say — and held under its cap by the same
  // write, so tries that cross cannot buy more looks than the cap. Beyond it, nothing looks at the picture at all.
  if (!(await countTry(deps.ddb, actor, today, now))) {
    throw new PhotoRefusal(429, 'too_many_tries', 'That is enough pictures for today. You can try again tomorrow.');
  }

  // The one look at the picture. A check that throws is a check that did not happen: refused the same way.
  const verdict = await deps.moderate(bytes).catch((err: unknown) => {
    console.error(JSON.stringify({ level: 'error', msg: 'photo_not_checked', err: err instanceof Error ? err.name : 'unknown' }));
    return 'unchecked' as const;
  });
  if (verdict === 'refuse') throw new PhotoRefusal(422, 'not_sendable', 'Wick cannot send that picture.');
  if (verdict !== 'pass') throw new PhotoRefusal(503, 'not_checked', 'Wick could not check that picture just now. Try again in a moment.');

  const photoId = key ?? deps.newId();
  const row = { photoId, sentBy: actor.userId, sentByName: cleanName(membership.name), sentAt: now };
  if (!(await claimPhoto(deps.ddb, actor.householdId, row))) {
    // Another try with this key got there between the look and the claim: that one is the sending.
    const other = await alreadyThere(photoId);
    if (other) return other;
    throw new PhotoRefusal(409, 'key_in_use', CHOOSE_AGAIN);
  }

  // Counted again now that the claim is made: sendings that crossed are each in the other's count.
  if ((await sentToday()) > MAX_PHOTOS_A_DAY) {
    await releasePhoto(deps.ddb, actor.householdId, row).catch(failed('row'));
    throw tooMany();
  }

  let stored = false;
  let carded = false;
  try {
    await deps.objects.put(actor.householdId, photoId, bytes);
    stored = true;
    carded = true;
    await deps.sendCard(buildPhotoCard(household, photoId, row.sentByName, now));
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'photo_not_sent', step: stored ? 'card' : 'object', err: err instanceof Error ? err.name : 'unknown' }));
    // Undone in the order that leaves least behind. A card is stored before it is pushed (egress.ts), so one half
    // sent could still arrive, with no picture behind it: it is taken back.
    if (carded) await deps.withdrawCard(actor.householdId, photoCardId(photoId)).catch(failed('card'));
    // Only an object this sending put. One that was already there under the id is somebody's picture, and stays.
    if (stored) await deps.objects.remove(actor.householdId, photoId).catch(failed('object'));
    await releasePhoto(deps.ddb, actor.householdId, row).catch(failed('row'));
    throw new PhotoRefusal(502, 'not_sent', `Your picture could not be sent just now. Nothing reached ${resident}’s television. Try again in a moment.`);
  }

  return sent(photoId);
}
