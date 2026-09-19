/**
 * Day agent — picks at most three items from real Bee facts.
 *
 * Selection rubric, in priority order:
 *   1. a commitment with a near deadline that nothing else has surfaced
 *   2. a self-referential wellbeing mention whose FREQUENCY changed
 *      (the delta is computed from real counts, never guessed by the model)
 *   3. anything queued from the family
 *
 * Hard rules: never more than three; never the same item twice in seven days
 * unless its deadline moved; never a verbatim quote (INV-4 — enforced
 * upstream in services/connectors/bee/src/normalise.ts, which is the only
 * place `Fact.content`/`Commitment.content` are ever produced); phrase as an
 * offer, never an instruction.
 *
 * Entirely pure and injectable, in the same style as door/handle.ts and
 * door/roster.ts — no AWS import here. See day/lambda.ts for the
 * composition root that supplies real Bee/DynamoDB data.
 */
import { createHash } from 'node:crypto';
import { MAX_DAY_ITEMS, type CardAction, type Commitment, type DayCard, type Fact } from '@wick/contracts';

export const DAY_GREETING = 'A few things from today.';

/** A commitment counts as "near" within this window. Beyond it, it isn't worth surfacing yet. */
export const NEAR_DEADLINE_MS = 4 * 24 * 60 * 60 * 1000; // 4 days

/** Below this many mentions this week, a wellbeing mention isn't a *pattern* yet — just one thing said once. */
export const MIN_HEALTH_MENTIONS_FOR_PATTERN = 2;

export interface PendingFamilyMessage {
  readonly fromName: string;
}

/** What "already shown" means for an item: when, and — for commitments only — with what deadline. */
export interface ShownRecord {
  readonly shownAt: number;
  readonly dueAt?: number;
}

export interface DaySelectionInput {
  /** Not-yet-due, not-yet-completed commitments. */
  readonly commitments: readonly Commitment[];
  /** HEALTH-class facts observed in the current 7-day window. */
  readonly healthFactsThisWeek: readonly Fact[];
  /** HEALTH-class facts observed in the preceding 7-day window — the baseline for the delta. */
  readonly healthFactsPriorWeek: readonly Fact[];
  readonly pendingFamilyMessage?: PendingFamilyMessage;
  /** Item id -> when (and, for a commitment, with what deadline) it was last shown. */
  readonly alreadyShown: ReadonlyMap<string, ShownRecord>;
  readonly now: number;
}

export type DayItemSource = 'COMMITMENT' | 'HEALTH_PATTERN' | 'FAMILY';

export interface DayItem {
  readonly factId: string;
  readonly text: string;
  readonly source: DayItemSource;
  /** Present for COMMITMENT items only — carried through so the caller can update alreadyShown. */
  readonly dueAt?: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function wasShownRecently(id: string, dueAt: number | undefined, input: DaySelectionInput): boolean {
  const record = input.alreadyShown.get(id);
  if (!record) return false;
  if (input.now - record.shownAt >= SEVEN_DAYS_MS) return false;
  // The one exception: a commitment whose deadline has moved since it was last shown is news again.
  if (dueAt !== undefined && record.dueAt !== undefined && dueAt !== record.dueAt) return false;
  return true;
}

/**
 * Rubric 1. The soonest-due commitment, within the near-deadline window, not
 * already shown this week (unless its deadline moved). Bee's own text is
 * carried through unedited — never rewritten into an imperative — which is
 * how this stays "an offer, never an instruction" without needing NLG.
 */
function pickCommitment(input: DaySelectionInput): DayItem | undefined {
  const candidates = input.commitments
    .filter((c) => c.dueAt !== undefined && c.dueAt >= input.now && c.dueAt - input.now <= NEAR_DEADLINE_MS)
    .filter((c) => !wasShownRecently(c.id, c.dueAt, input))
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));

  const chosen = candidates[0];
  if (!chosen) return undefined;
  return {
    factId: chosen.id,
    text: chosen.content,
    source: 'COMMITMENT',
    ...(chosen.dueAt !== undefined ? { dueAt: chosen.dueAt } : {}),
  };
}

/**
 * Rubric 2. A wellbeing pattern, not a single mention — the delta is a plain
 * count comparison over two real windows, never a guess. The most recent
 * fact in this week's window carries the wording; the pattern is what makes
 * it worth surfacing.
 */
function pickHealthPattern(input: DaySelectionInput): DayItem | undefined {
  const thisWeek = input.healthFactsThisWeek.length;
  const priorWeek = input.healthFactsPriorWeek.length;
  if (thisWeek < MIN_HEALTH_MENTIONS_FOR_PATTERN || thisWeek <= priorWeek) return undefined;

  const candidates = [...input.healthFactsThisWeek]
    .sort((a, b) => b.observedAt - a.observedAt)
    .filter((f) => !wasShownRecently(f.id, undefined, input));

  const chosen = candidates[0];
  if (!chosen) return undefined;
  return { factId: chosen.id, text: chosen.content, source: 'HEALTH_PATTERN' };
}

/** Rubric 3. A teaser only — the message itself is its own MessageCard (M3), not duplicated here. */
function pickFamilyItem(input: DaySelectionInput): DayItem | undefined {
  if (!input.pendingFamilyMessage) return undefined;
  const id = `family-pending-${input.pendingFamilyMessage.fromName}`;
  if (wasShownRecently(id, undefined, input)) return undefined;
  return { factId: id, text: `${input.pendingFamilyMessage.fromName} has sent you a message.`, source: 'FAMILY' };
}

/** At most three, in rubric priority order. Never guesses a fourth. */
export function selectDayItems(input: DaySelectionInput): readonly DayItem[] {
  const items = [pickCommitment(input), pickHealthPattern(input), pickFamilyItem(input)].filter(
    (item): item is DayItem => item !== undefined,
  );
  return items.slice(0, MAX_DAY_ITEMS);
}

function cardIdFor(items: readonly DayItem[], isoDay: string): string {
  const basis = items.map((i) => i.factId).join('|');
  return `day-${isoDay}-${createHash('sha256').update(basis).digest('base64url').slice(0, 10)}`;
}

export interface BuildDayCardInput {
  readonly items: readonly DayItem[];
  readonly householdId: string;
  readonly correlationId: string;
  readonly now: number;
  /** UTC calendar day, e.g. "2026-09-15" — makes the card id stable across a redelivered trigger. */
  readonly isoDay: string;
}

/**
 * Silence is the default state (Principle 5): a day with nothing worth
 * surfacing produces no card at all, not an empty one.
 */
export function buildDayCard(input: BuildDayCardInput): DayCard | null {
  if (input.items.length === 0) return null;

  const actions: readonly CardAction[] = [{ id: 'dismiss', label: 'Got it', kind: 'dismiss' }];

  return {
    type: 'DAY',
    id: cardIdFor(input.items, input.isoDay),
    householdId: input.householdId,
    correlationId: input.correlationId,
    createdAt: input.now,
    actions,
    greeting: DAY_GREETING,
    items: input.items.map((i) => ({ text: i.text, factId: i.factId })),
  };
}
