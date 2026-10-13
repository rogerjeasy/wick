/**
 * Sarah's television, a wave (packages/contracts familyTelevision.ts, card
 * kind `wave`): one button on the home screen, for whoever is in the room.
 *
 * What it puts on the resident's television is a note — a MESSAGE card,
 * like send_note_to_tv's — whose one sentence is Wick's own, under the name
 * of the member the television belongs to, with two things she can press:
 * "Wave back", and "Not now". Nothing in it is written by the family, and
 * nothing in a request can change a word of it (INV-8). It goes through the
 * sender the server was given (INV-2) and waits for a quiet moment like any
 * note (INV-5).
 *
 * Why a note, and not a card of its own kind: her television already knows
 * how to show one and the edge already keeps which of a note's buttons she
 * pressed (edge-device note-reply.mjs) — so a wave works on every
 * television as it is today, with nothing rebuilt and nothing redeployed
 * but this server. Its id says it is a wave (`note-wave-…`), and
 * get_replies leaves those out: a wave is not something the family wrote,
 * and "Wave back" is not a reply to read out.
 *
 * One row per member, `HH#<household>` / `WAVE#<userId>`: the wave they
 * last sent. Every write is conditional — a new wave on the row being as it
 * was read, so two televisions pressed together send one; "seen" on the
 * wave being the one that came back.
 *
 * The rule that keeps her answer hers: only "Wave back" is ever told. A
 * wave she put away looks, from here, exactly like one she has not seen —
 * the same sentence, the same ten minutes before the button returns, the
 * same thing done about the old card when another is sent. Otherwise
 * putting it away would itself say something.
 */
import { randomUUID } from 'node:crypto';
import { DeleteItemCommand, GetItemCommand, PutItemCommand, UpdateItemCommand, type AttributeValue, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { FAMILY_TV_PRESSES, FAMILY_TV_WAVE_CARD, familyTvCardId, type FamilyTvCard, type FamilyTvWave, type QueuedCard } from '@wick/contracts';
import { firstName } from '../tools/get_reach_request.js';
import type { TvCaller } from './familyTvTypes.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

type Item = Record<string, AttributeValue>;

export const WAVE_SK_PREFIX = 'WAVE#';
/** A wave's card on her television. A note's id, so the edge keeps her press; marked, so nothing takes it for a note the family wrote. */
export const WAVE_CARD_PREFIX = 'note-wave-';
export const isWaveCardId = (cardId: unknown): boolean => typeof cardId === 'string' && cardId.startsWith(WAVE_CARD_PREFIX);

/** How long before a member can wave again, whatever she did with the last one short of waving back. */
export const WAVE_AGAIN_AFTER_MS = 10 * 60_000;
/** How long "… waved back" stays on the family television if nobody says they have seen it. */
export const WAVE_BACK_SHOWN_MS = 12 * 60 * 60_000;
/** How long after a wave her answer is still looked for; then the row is the table's to forget. */
export const WAVE_KEPT_MS = 48 * 60 * 60_000;

/** A wave's id on the family side: the moment it was sent, as a request to ring's is. */
export const WAVE_ID = /^\d{13,16}$/;

/** The two things she can press. The first is the only one anybody is told of. */
const WAVE_BACK = 'Wave back';
const PUT_AWAY = 'Not now';

interface WaveRow {
  readonly waveId: string;
  readonly cardId: string;
  readonly sentAt: number;
  readonly seenAt?: number;
  readonly item: Item;
}

/** How a member's last wave stands. */
export interface WaveStanding {
  readonly row?: WaveRow;
  /** When she pressed "Wave back". Absent for anything else she did, and for nothing at all. */
  readonly backAt?: number;
}

const waveKey = (who: TvCaller): Item => ({ pk: { S: `HH#${who.householdId}` }, sk: { S: `${WAVE_SK_PREFIX}${who.userId}` } });

function readRow(item: Item | undefined): WaveRow | undefined {
  const waveId = item?.waveId?.S;
  const cardId = item?.cardId?.S;
  const sentAt = Number(item?.sentAt?.N);
  if (!item || !waveId || !cardId || !Number.isFinite(sentAt)) return undefined;
  const seenAt = Number(item.seenAt?.N);
  return { waveId, cardId, sentAt, ...(Number.isFinite(seenAt) ? { seenAt } : {}), item };
}

/**
 * When she waved back, from the wave's own card as the edge keeps it: her
 * press is the reply the card itself offered first. Any other press — and
 * any reply this card did not offer — is nothing.
 */
function wavedBackAt(item: Item | undefined): number | undefined {
  const raw = item?.data?.S;
  const reply = item?.replyText?.S;
  const at = Number(item?.repliedAt?.N);
  if (!raw || reply === undefined || !Number.isFinite(at)) return undefined;
  try {
    const card = (JSON.parse(raw) as { card?: { type?: unknown; suggestedReplies?: unknown } }).card;
    const offered: unknown = card?.type === 'MESSAGE' && Array.isArray(card.suggestedReplies) ? card.suggestedReplies[0] : undefined;
    return reply === offered ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The member's last wave, and whether it came back: one read, and one more
 * of the wave's card while her answer could still matter — not once it has
 * been seen here, and not once the wave is days old.
 */
export async function loadWave(ddb: DynamoDBClient, who: TvCaller, now: number): Promise<WaveStanding> {
  // Consistent: a press a moment ago is decided on it, and the button says so at once.
  const row = readRow((await ddb.send(new GetItemCommand({ TableName: TABLE, Key: waveKey(who), ConsistentRead: true }))).Item);
  if (!row) return {};
  if (row.seenAt !== undefined || now - row.sentAt >= WAVE_KEPT_MS) return { row };
  const card = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: `HH#${who.householdId}` }, sk: { S: `CARD#${row.cardId}` } } }));
  const backAt = wavedBackAt(card.Item);
  return { row, ...(backAt === undefined ? {} : { backAt }) };
}

/** Sent lately and not come back: there is nothing to do but wait, and no second wave. */
const onItsWay = (standing: WaveStanding, now: number): boolean =>
  standing.row !== undefined && standing.backAt === undefined && standing.row.seenAt === undefined && now - standing.row.sentAt < WAVE_AGAIN_AFTER_MS;

/** Come back, and nobody here has said they saw it. */
const cameBack = (standing: WaveStanding, now: number): standing is { row: WaveRow; backAt: number } =>
  standing.row !== undefined && standing.backAt !== undefined && standing.row.seenAt === undefined && now - standing.backAt < WAVE_BACK_SHOWN_MS;

/** The wave button as the home screen shows it: to be pressed, or saying the last one is on its way. */
export function waveButton(who: TvCaller, standing: WaveStanding, now: number): FamilyTvWave {
  const resident = who.household.residentName;
  const label = `Wave to ${resident}`;
  return onItsWay(standing, now) ? { label, line: `Your wave is on its way to ${resident}’s television.` } : { label, cardId: FAMILY_TV_WAVE_CARD };
}

/** "… waved back.", until somebody here says they have seen it. */
export function waveBackCard(who: TvCaller, standing: WaveStanding, now: number): FamilyTvCard | undefined {
  if (!cameBack(standing, now)) return undefined;
  return {
    id: familyTvCardId('wave', standing.row.waveId),
    kind: 'wave',
    headline: `${who.household.residentName} waved back.`,
    actions: [{ id: FAMILY_TV_PRESSES.seen, label: 'All right', kind: 'primary' }],
  };
}

/** The card a wave puts on her television. Every word is here; none comes from anywhere else. */
function waveCard(who: TvCaller, cardId: string, now: number): QueuedCard {
  return {
    id: cardId,
    // Like a note: it waits for a natural break, and never arrives in the middle of a programme (INV-5).
    urgency: 'DEFERRED',
    queuedAt: now,
    shownCount: 0,
    card: {
      type: 'MESSAGE',
      id: cardId,
      householdId: who.householdId,
      correlationId: cardId,
      createdAt: now,
      actions: [],
      // The name of the person the resident allowed, as on a note (send_note_to_tv.ts).
      fromName: who.membership.name,
      // The television is named, not the person: whoever is in the room may have pressed it.
      transcript: `A wave to you from ${firstName(who.membership.name)}’s television.`,
      suggestedReplies: [WAVE_BACK, PUT_AWAY],
    },
  };
}

const refused = (err: unknown): boolean => (err as { name?: string }).name === 'ConditionalCheckFailedException';

export interface WaveSenders {
  /** egress.ts's sendToDevice (INV-2). */
  readonly sendCard: (card: QueuedCard) => Promise<void>;
  /** egress.ts's takeBackFromDevices (INV-2). */
  readonly withdrawCard: (householdId: string, cardId: string) => Promise<void>;
}

/**
 * Sends a wave. False when the member's last one is still on its way —
 * from this television or another of theirs a moment ago.
 *
 * The row is claimed before anything reaches her television, so two presses
 * are one wave; the card it replaces is taken back before the new one goes,
 * so she never has two of a member's waves at once; and if the new one
 * cannot be sent the claim is undone, so nobody is told a wave is on its
 * way that is not.
 */
export async function sendWave(ddb: DynamoDBClient, senders: WaveSenders, who: TvCaller, now: number): Promise<boolean> {
  const standing = await loadWave(ddb, who, now);
  if (onItsWay(standing, now)) return false;

  const before = standing.row;
  const waveId = String(now);
  const cardId = `${WAVE_CARD_PREFIX}${randomUUID()}`;
  try {
    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        ...waveKey(who),
        waveId: { S: waveId },
        cardId: { S: cardId },
        sentAt: { N: String(now) },
        ttl: { N: String(Math.floor((now + WAVE_KEPT_MS) / 1000)) },
      },
      // Only over the wave that was looked at: one sent in the meantime stands.
      ...(before
        ? { ConditionExpression: 'waveId = :seen', ExpressionAttributeValues: { ':seen': { S: before.waveId } } }
        : { ConditionExpression: 'attribute_not_exists(pk)' }),
    }));
  } catch (err) {
    if (!refused(err)) throw err;
    return false;
  }

  try {
    // Whatever she did with the earlier one short of waving back — nothing, or "Not now" — the same is done about it.
    if (before && standing.backAt === undefined) await senders.withdrawCard(who.householdId, before.cardId);
    await senders.sendCard(waveCard(who, cardId, now));
  } catch (err) {
    // Undone only while the row is still this wave's: as it was before, or gone if there was none.
    const mine = { ConditionExpression: 'waveId = :mine', ExpressionAttributeValues: { ':mine': { S: waveId } } };
    const undone = before
      ? ddb.send(new PutItemCommand({ TableName: TABLE, Item: before.item, ...mine }))
      : ddb.send(new DeleteItemCommand({ TableName: TABLE, Key: waveKey(who), ...mine }));
    await undone.catch((undo: unknown) => console.error(JSON.stringify({ level: 'error', msg: 'wave_not_undone', err: undo instanceof Error ? undo.name : 'unknown' })));
    throw err;
  }
  return true;
}

/**
 * "All right" on a wave that came back. False for anything else — a wave
 * that has not come back most of all: saying one was seen must never be a
 * way to wave again sooner.
 */
export async function markWaveSeen(ddb: DynamoDBClient, who: TvCaller, waveId: string, now: number): Promise<boolean> {
  const standing = await loadWave(ddb, who, now);
  if (!cameBack(standing, now) || standing.row.waveId !== waveId) return false;
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: waveKey(who),
      UpdateExpression: 'SET seenAt = :at',
      ConditionExpression: 'waveId = :wave AND attribute_not_exists(seenAt)',
      ExpressionAttributeValues: { ':at': { N: String(now) }, ':wave': { S: waveId } },
    }));
    return true;
  } catch (err) {
    if (!refused(err)) throw err;
    return false;
  }
}
