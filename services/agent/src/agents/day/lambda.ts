/**
 * 30-minute schedule entrypoint (docs/WICK-TECHNICAL.md §5.1: "Day | Bee SSE
 * delta, or 30-min timer") — the timer alternative, because a Lambda cannot
 * hold the household bridge's long-lived SSE connection to the local Bee
 * proxy (§7.2's proxy is loopback-only inside the house). The bridge
 * (services/connectors/bee/src/sse.ts + normalise.ts) is the piece that
 * turns Bee facts/todos into typed Fact/Commitment records; a cloud-side
 * ingestion endpoint that receives the bridge's mTLS post and writes
 * FACT#<class>#<ts>#<id> rows (facts.ts) is the piece this lambda assumes
 * already exists upstream of it and is not built in this pass — see the
 * PR/commit this file shipped in. Until it exists, this lambda finds nothing
 * to query and sends no card, which is the correct failure mode (Principle
 * 5: silence is the default state), not a crash.
 *
 * Thin composition, matching door/lambda.ts's and narrator/lambda.ts's own
 * convention: the logic worth testing lives in index.ts and facts.ts; this
 * only wires real AWS clients to it and is left untested the same way.
 *
 * `alreadyShown` is reconstructed from the last 7 days of this household's
 * own DAY cards rather than a dedicated table — DayCard.items only carries
 * {text, factId}, not a commitment's dueAt, so a resurfaced commitment whose
 * deadline moved will wait out the full 7 days here rather than reappearing
 * immediately (index.ts's own tests cover the ideal behaviour when a caller
 * *can* supply the prior dueAt; this lambda is the pragmatic approximation
 * until DAY cards carry more state).
 */
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import type { Commitment, DayCard, Fact, QueuedCard } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { buildDayCard, selectDayItems, type DaySelectionInput, type ShownRecord } from './index.js';
import { factRangeKeys, parseFactItem } from './facts.js';
import { sendToDevice } from '../../egress.js';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME ?? '';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function loadFactsInRange(householdId: string, cls: 'HEALTH' | 'COMMITMENT', range: { startMs: number; endMs: number }) {
  const { from, to } = factRangeKeys(cls, range);
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':from': { S: from }, ':to': { S: to } },
  }));
  return (res.Items ?? []).map(parseFactItem).filter((f): f is Fact | Commitment => f !== undefined);
}

/** The most recently queued, not-yet-shown MESSAGE card, if any (M3). Pure — unit-testable independent of the Query above. */
export function pickPendingFamilyMessage(cards: readonly QueuedCard[]): { fromName: string } | undefined {
  const pending = cards
    .filter((q) => q.card.type === 'MESSAGE' && q.shownCount === 0)
    .sort((a, b) => b.queuedAt - a.queuedAt)[0];
  return pending && pending.card.type === 'MESSAGE' ? { fromName: pending.card.fromName } : undefined;
}

/** Reconstructs the "shown in the last 7 days" set from this household's own recent DAY cards. See header. */
export function buildAlreadyShown(recentDayCards: readonly DayCard[]): ReadonlyMap<string, ShownRecord> {
  const map = new Map<string, ShownRecord>();
  for (const card of recentDayCards) {
    for (const item of card.items) {
      const existing = map.get(item.factId);
      if (!existing || card.createdAt > existing.shownAt) map.set(item.factId, { shownAt: card.createdAt });
    }
  }
  return map;
}

async function loadPendingCards(householdId: string): Promise<readonly QueuedCard[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: 'CARD#' } },
  }));
  return (res.Items ?? [])
    .map((item) => item.data?.S)
    .filter((s): s is string => Boolean(s))
    .map((s) => JSON.parse(s) as QueuedCard);
}

export const handler = async (): Promise<void> => {
  const householdId = process.env.WICK_HOUSEHOLD_ID;
  if (!householdId) throw new Error('WICK_HOUSEHOLD_ID not set');

  const now = Date.now();
  const [thisWeek, priorWeek, commitmentCandidates, pendingCards] = await Promise.all([
    loadFactsInRange(householdId, 'HEALTH', { startMs: now - WEEK_MS, endMs: now }),
    loadFactsInRange(householdId, 'HEALTH', { startMs: now - 2 * WEEK_MS, endMs: now - WEEK_MS }),
    loadFactsInRange(householdId, 'COMMITMENT', { startMs: now - 2 * WEEK_MS, endMs: now }),
    loadPendingCards(householdId),
  ]);

  const recentDayCards = pendingCards
    .filter((q): q is QueuedCard & { card: DayCard } => q.card.type === 'DAY')
    .map((q) => q.card)
    .filter((c) => now - c.createdAt < WEEK_MS);

  const pendingFamilyMessage = pickPendingFamilyMessage(pendingCards);
  const input: DaySelectionInput = {
    commitments: commitmentCandidates as readonly Commitment[],
    healthFactsThisWeek: thisWeek as readonly Fact[],
    healthFactsPriorWeek: priorWeek as readonly Fact[],
    alreadyShown: buildAlreadyShown(recentDayCards),
    now,
    ...(pendingFamilyMessage ? { pendingFamilyMessage } : {}),
  };

  const items = selectDayItems(input);
  const isoDay = new Date(now).toISOString().slice(0, 10);
  const correlationId = randomUUID();
  const card = buildDayCard({ items, householdId, correlationId, now, isoDay });

  if (!card) {
    console.log(JSON.stringify({ level: 'info', msg: 'day_card_skipped_no_items' }));
    return;
  }

  // sendToDevice already writes the CARD# item as the queue's source of
  // truth (egress.ts) — nothing further to persist here.
  const queued: QueuedCard = { id: card.id, urgency: 'DEFERRED', card, queuedAt: now, shownCount: 0 };
  await sendToDevice(queued, DEFAULT_POLICY);

  console.log(JSON.stringify({ level: 'info', msg: 'day_card_sent', correlationId, items: items.length }));
};
