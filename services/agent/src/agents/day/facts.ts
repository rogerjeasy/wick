/**
 * FACT#<class>#<ts>#<id> — §8.1's data model for the Day pillar's persisted
 * facts and commitments. Pure (de)serialisers, in the same style as
 * narrator/timeline.ts and rhythm/records.ts: no AWS import, so both the
 * ingestion path (the household bridge's cloud post, not yet built — see
 * day/lambda.ts's header) and this agent's own reads can share one
 * definition of the wire shape.
 *
 * The sort key is class-scoped and time-ordered so a single bounded Query —
 * "FACT#HEALTH# between two timestamps" — is exactly the frequency-delta
 * input selectDayItems needs (§5.3), the same BETWEEN-on-sk shape
 * get_today.ts and narrator/lambda.ts already use for EVT#.
 */
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { padTimestamp, type Commitment, type Fact, type FactClass } from '@wick/contracts';

export function factSortKey(fact: Fact): string {
  return `FACT#${fact.class}#${padTimestamp(fact.observedAt)}#${fact.id}`;
}

export function buildFactItem(householdId: string, fact: Fact): Record<string, AttributeValue> {
  return {
    pk: { S: `HH#${householdId}` },
    sk: { S: factSortKey(fact) },
    data: { S: JSON.stringify(fact) },
  };
}

export function parseFactItem(item: Record<string, AttributeValue>): Fact | Commitment | undefined {
  const raw = item.data?.S;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Fact | Commitment;
  } catch {
    return undefined;
  }
}

export interface FactRange {
  readonly startMs: number;
  /** Exclusive. */
  readonly endMs: number;
}

/** The sk BETWEEN bounds for a bounded Query over one class's facts. Upper bound mirrors get_today.ts's sentinel pattern. */
export function factRangeKeys(cls: FactClass, range: FactRange): { readonly from: string; readonly to: string } {
  return {
    from: `FACT#${cls}#${padTimestamp(range.startMs)}`,
    to: `FACT#${cls}#${padTimestamp(range.endMs - 1)}#￿`,
  };
}
