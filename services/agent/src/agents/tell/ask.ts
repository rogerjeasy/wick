/**
 * "Shall I tell Sarah?" — the asking.
 *
 * Something about today is unlike this household's usual (rhythm/
 * different.ts). Before any of it can reach the family, the resident is
 * asked on their own television, and shown the very sentence that would be
 * told (packages/contracts tell.ts). This file decides what is asked and
 * builds the card; answer.ts carries out the press.
 *
 * The rules, in order:
 *
 *   - Nobody to tell, nothing to ask. And then nothing is looked for either.
 *   - What the resident already keeps private is never asked about: the
 *     differences handed in are only those in classes they share
 *     (rhythm/loadDifferent.ts), so "Keep it to myself" is not asked twice
 *     in two different places.
 *   - Each difference is asked about once. The question is filed before the
 *     card is sent, so two runs at once cannot put it on the screen twice,
 *     and an answered question is never asked again. If the card then cannot
 *     be sent, the filing is undone, so it is asked next time rather than
 *     never.
 *
 * No model here. The sentence is the detector's own; the card's other words
 * are below.
 */
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { TELL_ACTIONS, TELL_SK_PREFIX, tellCardId, type FactClass, type QueuedCard } from '@wick/contracts';
import type { Difference, DifferenceKind } from '../../rhythm/different.js';
import type { FamilyMember } from '../door/askFamily.js';
import { familyToAsk } from '../door/index.js';

/** One question to the resident about one difference. */
export interface TellRow {
  readonly householdId: string;
  readonly differenceId: string;
  readonly kind: DifferenceKind;
  readonly factClass: Extract<FactClass, 'PRESENCE' | 'DOOR_EVENT'>;
  /** The lasting wording: what the resident is shown and, if they say so, what the family is told. */
  readonly sentence: string;
  /** The moment the difference is about. */
  readonly at: number;
  readonly askedAt: number;
  /** How many weeks of this household's own history it was measured against. */
  readonly weeksObserved: number;
}

export interface AskDeps {
  /** The differences in classes the resident shares, or undefined when they keep the shape of the week private. */
  readonly loadDifferences: (householdId: string) => Promise<{ readonly weeksObserved: number; readonly differences: readonly Difference[] } | undefined>;
  readonly listFamily: (householdId: string) => Promise<readonly FamilyMember[]>;
  /** Conditional write of TELL#<differenceId>; false when it was already asked. */
  readonly claimOnce: (row: TellRow) => Promise<boolean>;
  readonly release: (householdId: string, differenceId: string) => Promise<void>;
  readonly sendCard: (card: QueuedCard) => Promise<void>;
  readonly now: () => number;
  readonly newCorrelationId: () => string;
}

/** Long enough for the family to read what they were told a week later; then it is gone. */
const TELL_KEPT_FOR_SEC = 14 * 24 * 60 * 60;

const keySafe = (part: string): string => part.replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * The same difference is the same question: its kind, who it is about, and
 * the day (UTC, as the detector counts days). Not its words — those change
 * from "today" to "yesterday" while it is still one thing.
 */
export function differenceId(difference: Difference): string {
  const day = new Date(difference.at).toISOString().slice(0, 10);
  return [difference.kind, ...(difference.personId ? [keySafe(difference.personId)] : []), day].join('-');
}

/** The TELL# row. Pure, so its shape is tested without AWS. */
export function tellRowItem(row: TellRow): Record<string, AttributeValue> {
  return {
    pk: { S: `HH#${row.householdId}` },
    sk: { S: `${TELL_SK_PREFIX}${row.differenceId}` },
    differenceId: { S: row.differenceId },
    kind: { S: row.kind },
    factClass: { S: row.factClass },
    sentence: { S: row.sentence },
    at: { N: String(row.at) },
    askedAt: { N: String(row.askedAt) },
    weeksObserved: { N: String(row.weeksObserved) },
    ttl: { N: String(Math.floor(row.askedAt / 1000) + TELL_KEPT_FOR_SEC) },
  };
}

export interface TellCardInput {
  readonly householdId: string;
  readonly differenceId: string;
  readonly sentence: string;
  /** A first name, or "the family" (door/index.ts familyToAsk). */
  readonly who: string;
  readonly now: number;
  readonly correlationId: string;
}

/**
 * The card. Deferred like a note: it waits for a natural break, is shown at
 * two of them, and then waits on the home screen to be asked for (INV-5).
 * Nothing about a difference is urgent enough to interrupt a programme.
 */
export function buildTellCard(input: TellCardInput): QueuedCard {
  const id = tellCardId(input.differenceId);
  return {
    id,
    urgency: 'DEFERRED',
    queuedAt: input.now,
    shownCount: 0,
    card: {
      type: 'TELL',
      id,
      householdId: input.householdId,
      correlationId: input.correlationId,
      createdAt: input.now,
      headline: `Shall I tell ${input.who}?`,
      detail: input.sentence,
      actions: [
        { id: TELL_ACTIONS.tell, label: `Tell ${input.who}`, kind: 'primary' },
        // The way out, and last: saying nothing is always possible.
        { id: TELL_ACTIONS.keep, label: 'Keep it to myself', kind: 'dismiss' },
      ],
    },
  };
}

/** Asks the resident about every difference not asked about before. Returns the ones asked now. */
export async function askAboutDifferences(householdId: string, deps: AskDeps): Promise<readonly string[]> {
  const who = familyToAsk((await deps.listFamily(householdId)).map((member) => member.name));
  if (!who) return [];

  const found = await deps.loadDifferences(householdId);
  if (!found) return [];

  const asked: string[] = [];
  for (const difference of found.differences) {
    const id = differenceId(difference);
    const now = deps.now();
    const claimed = await deps.claimOnce({
      householdId,
      differenceId: id,
      kind: difference.kind,
      factClass: difference.factClass,
      sentence: difference.lasting,
      at: difference.at,
      askedAt: now,
      weeksObserved: found.weeksObserved,
    });
    if (!claimed) continue;

    try {
      await deps.sendCard(buildTellCard({ householdId, differenceId: id, sentence: difference.lasting, who, now, correlationId: deps.newCorrelationId() }));
      asked.push(id);
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'tell_card_not_sent', kind: difference.kind, err: err instanceof Error ? err.name : 'unknown' }));
      await deps.release(householdId, id);
    }
  }
  return asked;
}
