/**
 * Watch together, the family's half (packages/contracts/src/watch.ts): the
 * session row as the four tools read and write it, and what a family member
 * is told about it.
 *
 * A session is one row, `HH#<household>` / `WATCH#<sessionId>`. These tools
 * write the invitation, its being taken back before she has answered, the
 * family member sitting down, and their answer at the end. Everything the resident does — yes or no, "Start the film", where
 * the film is, her own answer — is written by the television's edge
 * (services/edge-device/lambda/watch-together.mjs), under conditions that
 * keep the rule in watch.ts whatever a television sends.
 *
 * `describeWatch` is the other half of that rule: where the film is appears
 * in a view only while the session is open, and a view is only ever made for
 * the person who sent the invitation (`mySession`). Nobody else in the
 * circle is told that anything is being watched.
 *
 * No Guardian class applies, for the reason get_replies gives: every piece
 * of this is something the resident chose, by pressing it, to share with
 * this one person. And no model runs here (§9.3): each tool is a read or
 * two and at most one write.
 */
import { GetItemCommand, QueryCommand, type AttributeValue, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  PROGRAMMES_ORIGIN,
  WATCH_ANSWERS,
  WATCH_QUESTION,
  WATCH_SILENT_AFTER_MS,
  WATCH_SK_PREFIX,
  isWatchAnswer,
  programmeById,
  watchCardId,
  watchWindow,
  type CardAction,
  type PlaybackStateName,
  type QueuedCard,
  type WatchAnswer,
  type WatchCardKind,
} from '@wick/contracts';

export const TABLE = process.env.TABLE_NAME ?? 'wick';
/** Where "three o'clock" is three o'clock. The same default as the Narrator's. */
export const HOUSEHOLD_TZ = process.env.WICK_HOUSEHOLD_TZ ?? 'Europe/London';

/**
 * Where the family member's player fetches the films from: the same origin
 * the television plays from (infra/programmes.tf), unless a deployment names
 * another. Read when asked, not when loaded, so the dev server can stand in
 * for it (__tests__/devServer.ts).
 */
const streamOrigin = (): string => process.env.WICK_PROGRAMMES_ORIGIN?.replace(/\/+$/, '') || PROGRAMMES_ORIGIN;

type Item = Record<string, AttributeValue>;

export interface WatchSession {
  readonly sessionId: string;
  readonly programmeId: string;
  readonly programmeTitle: string;
  readonly startsAt: number;
  readonly closesAt: number;
  /** The one person the session is shown to. */
  readonly invitedBy: string;
  /** Their first name, as the resident reads it on every card. */
  readonly invitedByName: string;
  readonly createdAt: number;
  /**
   * `withdrawn`: taken back by the person who sent it, before she answered
   * (withdraw_watch_invitation.ts). The edge answers only an invitation
   * still `invited`, so one taken back cannot be accepted afterwards.
   * `cancelled`: called off by that person after she had said yes, and
   * before the film was started; her television says so. The edge starts
   * only a session still `accepted`, so one called off cannot be started.
   */
  readonly status: 'invited' | 'accepted' | 'declined' | 'withdrawn' | 'cancelled';
  /** `cancelled` only: when her television was told so. Absent, she has not been told yet. */
  readonly toldAt?: number;
  readonly joinedAt?: number;
  readonly passedAt?: number;
  readonly startedAt?: number;
  /**
   * When her player stopped: the film ended, or she left it. Written once by
   * the edge with the position that says so, after which it keeps no other
   * (edge-device watch-together.mjs positionUpdate) — so it never unhappens.
   */
  readonly leftAt?: number;
  /** Where the film was, and when this server heard so. */
  readonly playback?: { readonly state: PlaybackStateName; readonly positionMs: number; readonly at: number };
  readonly askedAt?: number;
  readonly residentAnswer?: WatchAnswer;
  readonly familyAnswer?: WatchAnswer;
}

const num = (value: AttributeValue | undefined): number | undefined => (value?.N === undefined ? undefined : Number(value.N));
const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [key]: value } as { [P in K]: V }));

/**
 * One row per member, naming the last invitation they sent:
 * `HH#<household>` / `WATCHLATEST#<userId>`. It is what makes "one open
 * invitation at a time" true and not merely usual: a new invitation is
 * written together with this row, on the condition that the row still names
 * the invitation that was looked at and found settled (invite_to_watch.ts).
 * Two invitations sent in the same moment cannot both hold that condition.
 */
export const latestKey = (householdId: string, userId: string): Item => ({ pk: { S: `HH#${householdId}` }, sk: { S: `WATCHLATEST#${userId}` } });

export const sessionKey = (householdId: string, sessionId: string): Item => ({ pk: { S: `HH#${householdId}` }, sk: { S: `${WATCH_SK_PREFIX}${sessionId}` } });

/** The row an invitation starts as. `creditsMs` is there for the edge, which asks the question by it and cannot read the catalogue. */
export function invitationItem(householdId: string, session: WatchSession, creditsMs: number): Item {
  return {
    ...sessionKey(householdId, session.sessionId),
    sessionId: { S: session.sessionId },
    programmeId: { S: session.programmeId },
    programmeTitle: { S: session.programmeTitle },
    creditsMs: { N: String(creditsMs) },
    startsAt: { N: String(session.startsAt) },
    closesAt: { N: String(session.closesAt) },
    invitedBy: { S: session.invitedBy },
    invitedByName: { S: session.invitedByName },
    createdAt: { N: String(session.createdAt) },
    status: { S: session.status },
    // The table forgets it by itself, a week after it is over.
    ttl: { N: String(Math.floor(session.closesAt / 1000) + 7 * 86_400) },
  };
}

export function readSession(item: Item | undefined): WatchSession | undefined {
  const status = item?.status?.S;
  const startsAt = num(item?.startsAt);
  if (!item?.sessionId?.S || !item.programmeId?.S || !item.invitedBy?.S || startsAt === undefined) return undefined;
  if (status !== 'invited' && status !== 'accepted' && status !== 'declined' && status !== 'withdrawn' && status !== 'cancelled') return undefined;

  const pbState = item.pbState?.S as PlaybackStateName | undefined;
  const pbPositionMs = num(item.pbPositionMs);
  const pbAt = num(item.pbAt);
  return {
    sessionId: item.sessionId.S,
    programmeId: item.programmeId.S,
    programmeTitle: item.programmeTitle?.S ?? 'the film',
    startsAt,
    closesAt: num(item.closesAt) ?? watchWindow(startsAt).closesAt,
    invitedBy: item.invitedBy.S,
    invitedByName: item.invitedByName?.S ?? 'Someone',
    createdAt: num(item.createdAt) ?? 0,
    status,
    ...optional('toldAt', num(item.toldAt)),
    ...optional('joinedAt', num(item.joinedAt)),
    ...optional('passedAt', num(item.passedAt)),
    ...optional('startedAt', num(item.startedAt)),
    ...optional('leftAt', num(item.leftAt)),
    ...(pbState && pbPositionMs !== undefined && pbAt !== undefined ? { playback: { state: pbState, positionMs: pbPositionMs, at: pbAt } } : {}),
    ...optional('askedAt', num(item.askedAt)),
    ...(isWatchAnswer(item.residentAnswer?.S) ? { residentAnswer: item.residentAnswer.S } : {}),
    ...(isWatchAnswer(item.familyAnswer?.S) ? { familyAnswer: item.familyAnswer.S } : {}),
  };
}

/** One session, and only for the person who made it. Consistent: writes are decided on it. */
export async function mySession(ddb: DynamoDBClient, householdId: string, userId: string, sessionId: string): Promise<WatchSession | undefined> {
  const res = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: sessionKey(householdId, sessionId), ConsistentRead: true }));
  const session = readSession(res.Item);
  return session?.invitedBy === userId ? session : undefined;
}

/** Every session this person made, newest first. A handful at most: each is gone a week after it is over. */
export async function mySessions(ddb: DynamoDBClient, householdId: string, userId: string): Promise<WatchSession[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: WATCH_SK_PREFIX } },
  }));
  return (res.Items ?? [])
    .map(readSession)
    .filter((s): s is WatchSession => s?.invitedBy === userId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export type WatchState =
  /** On the television, not yet answered. */
  | 'invited'
  | 'declined'
  /** Taken back by the person who sent it, before she answered. Nothing is left on the television. */
  | 'withdrawn'
  /** She had said yes, and the person who asked called it off before the film was started. Her television says so. */
  | 'cancelled'
  /** She said yes; nobody has sat down yet. */
  | 'accepted'
  /** The family member has sat down; the television says so and waits for "Start the film". */
  | 'ready'
  /** She pressed "Not now" when it came to it. */
  | 'passed'
  | 'watching'
  /**
   * She started the film and left it before the credits. Her television
   * follows nobody after that (apps/tv-vega togetherReporter.ts: leaving is
   * final), so there is nothing left to sit down to — and nothing to wait
   * for either: another invitation can be sent at once.
   */
  | 'stopped'
  /** The film reached its credits: the one question, and each other's answers. */
  | 'watched'
  /** The time came and went without the film being seen through. */
  | 'over';

export interface WatchView {
  readonly sessionId: string;
  readonly film: string;
  readonly startsAt: number;
  /** The same moment, in words, where the house is. */
  readonly when: string;
  readonly state: WatchState;
  /** `accepted` only: whether the seat can be taken yet, and from when. */
  readonly canSitDown?: boolean;
  readonly opensAt?: number;
  /** What to play, while there is anything to follow. */
  readonly stream?: { readonly url: string; readonly durationMs: number; readonly attribution: string };
  /**
   * Where her film is. `ageMs` is how long ago this server heard so: a
   * player adds it (and the time since) to `positionMs` while PLAYING.
   * WAITING: her television is finding its place, or has gone quiet — stop
   * there and wait, do not run on alone.
   */
  readonly playback?: { readonly state: 'PLAYING' | 'PAUSED' | 'STOPPED' | 'WAITING'; readonly positionMs: number; readonly ageMs: number };
  readonly question?: string;
  /** Offered until the family member has answered. */
  readonly answers?: readonly { readonly key: WatchAnswer; readonly text: string }[];
  readonly yourAnswer?: string;
  readonly theirAnswer?: string;
}

const ANSWERS = (Object.entries(WATCH_ANSWERS) as [WatchAnswer, string][]).map(([key, text]) => ({ key, text }));

/** What the person who made a session is told about it now. */
export function describeWatch(session: WatchSession, now: number, timeZone: string = HOUSEHOLD_TZ): WatchView {
  const base = { sessionId: session.sessionId, film: session.programmeTitle, startsAt: session.startsAt, when: whenInWords(session.startsAt, timeZone) };
  const open = now < session.closesAt;
  const programme = programmeById(session.programmeId);
  const following = (): Pick<WatchView, 'stream' | 'playback'> => {
    if (!open || !programme) return {};
    const stream = { url: `${streamOrigin()}/${programme.id}/index.m3u8`, durationMs: programme.durationMs, attribution: programme.attribution };
    if (!session.playback) return { stream };
    const ageMs = Math.max(0, now - session.playback.at);
    const { state } = session.playback;
    const quiet = state === 'BUFFERING' || (state === 'PLAYING' && ageMs > WATCH_SILENT_AFTER_MS);
    return { stream, playback: { state: quiet ? 'WAITING' : (state as 'PLAYING' | 'PAUSED' | 'STOPPED'), positionMs: session.playback.positionMs, ageMs } };
  };

  if (session.status === 'declined') return { ...base, state: 'declined' };
  if (session.status === 'withdrawn') return { ...base, state: 'withdrawn' };
  if (session.status === 'cancelled') return { ...base, state: 'cancelled' };
  if (session.askedAt !== undefined) {
    return {
      ...base,
      state: 'watched',
      ...following(),
      question: WATCH_QUESTION,
      ...(session.familyAnswer ? { yourAnswer: WATCH_ANSWERS[session.familyAnswer] } : open ? { answers: ANSWERS } : {}),
      ...(session.residentAnswer ? { theirAnswer: WATCH_ANSWERS[session.residentAnswer] } : {}),
    };
  }
  if (!open) return { ...base, state: 'over' };
  if (session.status === 'invited') return { ...base, state: 'invited' };
  if (session.passedAt !== undefined) return { ...base, state: 'passed' };
  // Her player stopped before the credits (one that ended passed them first:
  // askedAt, above). Read from `leftAt`, which is written once and closes the
  // row to further positions — not from the last playback state, which a
  // later report could have changed back.
  if (session.startedAt !== undefined && session.leftAt !== undefined) return { ...base, state: 'stopped' };
  if (session.startedAt !== undefined) return { ...base, state: 'watching', ...following() };
  if (session.joinedAt !== undefined) return { ...base, state: 'ready', ...following() };
  const { opensAt } = watchWindow(session.startsAt);
  return { ...base, state: 'accepted', canSitDown: now >= opensAt, opensAt };
}

/** A session that still has something ahead of it: one of these, and no second invitation is sent. */
export const isOpen = (state: WatchState): boolean => state === 'invited' || state === 'accepted' || state === 'ready' || state === 'watching';

/** "Sunday 18 October at 3 pm" — the moment where the house is, as it is said on the television and to the family. */
export function whenInWords(at: number, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(at)).replace(',', '');
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
  const hour = Number(parts.find((p) => p.type === 'hour')!.value);
  const minute = parts.find((p) => p.type === 'minute')!.value;
  const clock = `${hour % 12 || 12}${minute === '00' ? '' : `:${minute}`} ${hour < 12 ? 'am' : 'pm'}`;
  return `${day} at ${clock}`;
}

/** The name the resident reads on a card: a first name, as on the door card's own button. */
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;

export const NOTHING_ASKED = (residentName: string): string => `You haven't asked ${residentName} to watch anything.`;
export const WITHDRAWN_TEXT = 'You took that invitation back. You can ask again whenever you like.';
export const CANCELLED_TEXT = 'You called that off. You can ask again whenever you like.';

/**
 * One of a session's cards for the television. DEFERRED, like every card
 * but the door's: an invitation waits for a natural break, and never
 * arrives in the middle of a programme (INV-5).
 */
export function watchCard(input: {
  readonly kind: WatchCardKind;
  readonly householdId: string;
  readonly session: Pick<WatchSession, 'sessionId' | 'invitedByName'>;
  readonly headline: string;
  readonly detail: string;
  readonly actions: readonly CardAction[];
  readonly now: number;
  readonly starts?: { readonly programmeId: string; readonly followedUntil: number };
}): QueuedCard {
  const id = watchCardId(input.kind, input.session.sessionId);
  return {
    id,
    urgency: 'DEFERRED',
    queuedAt: input.now,
    shownCount: 0,
    card: {
      type: 'WATCH',
      id,
      householdId: input.householdId,
      correlationId: `watch-${input.session.sessionId}`,
      createdAt: input.now,
      sessionId: input.session.sessionId,
      withName: input.session.invitedByName,
      headline: input.headline,
      detail: input.detail,
      actions: input.actions,
      ...(input.starts ?? {}),
    },
  };
}
