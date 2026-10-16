/**
 * The week the Sunday brief writes: the same NARR#<isoWeek> row the
 * Narrator writes (narrator/lambda.ts), which get_week_narrative reads.
 *
 * INV-7 is kept by not touching it. The brief never sets residentSeenAt;
 * her press on the week card does (edge-device device-event.mjs). And a
 * week she has already read is never rewritten: the family must read the
 * words she read. The edge marks a week seen by reading the row and
 * writing it back (its header says why), so the brief's write is
 * conditional on the row being exactly as it read it — a press that lands
 * between the two is never written over.
 *
 * Idempotent: a week the agents already wrote is not written again, so an
 * SQS message delivered twice costs one model run, not two.
 *
 * A demo home's weeks are simulated, and "already read" by a simulated
 * resident (accounts/demoHome.ts). Rewriting the newest of them is how a
 * judge sees the agents' week at once; it keeps `simulated`, and when it
 * was written and read, so nothing about it pretends to be lived.
 */
import { GetItemCommand, PutItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import type { WeekNarrative } from '@wick/contracts';

export interface StoredWeek {
  readonly narrative: WeekNarrative;
  /** The row's `data` exactly as read: what a write is conditional on. */
  readonly raw: string;
}

/** What a rewritten simulated week keeps of the one it replaces. */
export interface KeptFromSimulated {
  readonly simulated: true;
  readonly residentSeenAt?: number;
  readonly generatedAt: number;
}

export type BriefDecision =
  | { readonly write: true; readonly keep?: KeptFromSimulated }
  | { readonly write: false; readonly why: 'already_written' | 'already_seen' };

/** The agents' own week: their source, or their suggestion (the Narrator never writes one). */
export const writtenByAgents = (week: WeekNarrative): boolean => week.textSource === 'agents' || week.suggestion !== undefined;

export function briefDecision(existing: StoredWeek | undefined): BriefDecision {
  if (!existing) return { write: true };
  const week = existing.narrative;
  if (writtenByAgents(week)) return { write: false, why: 'already_written' };
  if (week.simulated) {
    return {
      write: true,
      keep: { simulated: true, generatedAt: week.generatedAt, ...(week.residentSeenAt === undefined ? {} : { residentSeenAt: week.residentSeenAt }) },
    };
  }
  if (week.residentSeenAt !== undefined) return { write: false, why: 'already_seen' };
  return { write: true };
}

export type WeekSend = (command: GetItemCommand | PutItemCommand) => Promise<{ Item?: Record<string, AttributeValue> | undefined }>;

export interface WeekStore {
  load(householdId: string, isoWeek: string): Promise<StoredWeek | undefined>;
  /** False when the row changed since `existing` was read (or appeared, when there was none): nothing is written. */
  save(narrative: WeekNarrative, existing: StoredWeek | undefined): Promise<boolean>;
}

const keyOf = (householdId: string, isoWeek: string) => ({ pk: { S: `HH#${householdId}` }, sk: { S: `NARR#${isoWeek}` } });

export function weekStore(send: WeekSend, table: string): WeekStore {
  return {
    async load(householdId, isoWeek) {
      // Consistent: what is read is what the write below is conditional on.
      const res = await send(new GetItemCommand({ TableName: table, Key: keyOf(householdId, isoWeek), ConsistentRead: true }));
      const raw = res.Item?.data?.S;
      return raw === undefined ? undefined : { narrative: JSON.parse(raw) as WeekNarrative, raw };
    },

    async save(narrative, existing) {
      try {
        await send(new PutItemCommand({
          TableName: table,
          Item: { ...keyOf(narrative.householdId, narrative.isoWeek), data: { S: JSON.stringify(narrative) } },
          ...(existing === undefined
            ? { ConditionExpression: 'attribute_not_exists(pk)' }
            : { ConditionExpression: '#data = :read', ExpressionAttributeNames: { '#data': 'data' }, ExpressionAttributeValues: { ':read': { S: existing.raw } } }),
        }));
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
  };
}
