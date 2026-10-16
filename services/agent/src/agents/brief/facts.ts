/**
 * What the Sunday brief knows beyond the Narrator's counts: the visits the
 * family arranged that week and how each ended (errands, packages/contracts
 * errand.ts), whether a film was played on her television, and whether a
 * usual visitor came less than usual. The analyst node puts these beside
 * factLines (graphs/weeklyBrief.ts); the suggester's choices are checked
 * against them (suggestion.ts).
 *
 * The same rule as weekFacts.ts: code says what happened, in lines the
 * model is shown, and nothing here carries a number — checkNarrative allows
 * only the Narrator's counts, so a line with a number in it would be a
 * number the model could repeat and be refused for.
 *
 * Errands are written by another part of Wick (the errand state machine).
 * Their rows are read here, not trusted: a row this cannot read is left
 * out, never guessed at.
 */
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { ERRAND_LIMITS, ERRAND_SK_PREFIX, ERRAND_STATUSES, type ErrandStatus, type RhythmDelta } from '@wick/contracts';
import { VISIT_METRIC_PREFIX } from '../../rhythm/baseline.js';
import type { WeekRange } from '../narrator/isoWeek.js';

type Item = Record<string, AttributeValue>;

/** The part of an errand the week is told: who was expected, by whom, when, and how it ended. */
export interface ErrandOutcome {
  readonly who: string;
  readonly createdByName: string;
  readonly at: number;
  readonly status: ErrandStatus;
}

const isStatus = (value: unknown): value is ErrandStatus => typeof value === 'string' && (ERRAND_STATUSES as readonly string[]).includes(value);
const isName = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;

/** The fields, from the row's JSON blob if it keeps one, else from its own attributes. */
function fieldsOf(item: Item): Record<string, unknown> | undefined {
  const blob = item.data?.S;
  if (blob !== undefined) {
    try {
      const parsed: unknown = JSON.parse(blob);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return {
    who: item.who?.S,
    createdByName: item.createdByName?.S,
    at: item.at?.N === undefined ? undefined : Number(item.at.N),
    status: item.status?.S,
  };
}

/** An ERRAND# row, or undefined if it is not one this can read. */
export function readErrandRow(item: Item): ErrandOutcome | undefined {
  if (!item.sk?.S?.startsWith(ERRAND_SK_PREFIX)) return undefined;
  const f = fieldsOf(item);
  if (!f) return undefined;
  if (!isName(f.who, ERRAND_LIMITS.whoMaxChars) || !isName(f.createdByName, 80)) return undefined;
  if (typeof f.at !== 'number' || !Number.isFinite(f.at) || !isStatus(f.status)) return undefined;
  return { who: f.who.trim(), createdByName: f.createdByName.trim(), at: f.at, status: f.status };
}

/**
 * How each errand due in the week ended, as a fact. In the door's terms
 * only: "someone rang around the time", never "the plumber came" — the door
 * saw a ring, not who rang. The week is read by the whole family, so no
 * member is named: an errand is its author's to be told about
 * (tools/get_errands.ts). An errand called off — by its author, or closed
 * quietly because its author is no longer allowed (errand/step.ts) — is
 * not told, nor one still under way or one that failed: none ended in
 * anything the door saw.
 */
export function errandLines(errands: readonly ErrandOutcome[], range: WeekRange): string[] {
  return errands
    .filter((e) => e.at >= range.startMs && e.at < range.endMs)
    .sort((a, b) => a.at - b.at)
    .flatMap((e) => {
      const arranged = `A visit from ${e.who} was arranged`;
      if (e.status === 'rang') return [`${arranged}: someone rang the doorbell around the time they were expected.`];
      if (e.status === 'no_show') return [`${arranged}: nobody rang the doorbell while they were expected.`];
      return [];
    });
}

/** The fact the suggester's "watch together" rests on. */
export const FILM_LINE = 'A film was played on the television this week.';

/**
 * Whether a film was played that week. The television's PLAYING is counted
 * in day-of-week/hour buckets (`RHYTHM#tv_activity#<device>#power_on#<bucket>`,
 * edge-device device-event.mjs), each keeping when it last happened: a
 * bucket last played inside the week is a film played that week. The
 * buckets cannot say how many, so this says only whether.
 */
export function watchedFilms(items: readonly Item[], range: WeekRange): boolean {
  return items.some((item) => {
    const sk = item.sk?.S ?? '';
    if (!sk.startsWith('RHYTHM#tv_activity#') || !sk.includes('#power_on#')) return false;
    const at = Number(item.lastSeenAt?.N);
    return Number.isFinite(at) && at >= range.startMs && at < range.endMs;
  });
}

/**
 * Whether someone who usually visits came less than usual — decided by the
 * Rhythm baseline's own verdict (rhythm/baseline.ts), so below three weeks
 * of history nobody can have missed a usual visit.
 */
export function missedUsualVisit(deltas: readonly RhythmDelta[]): boolean {
  return deltas.some((d) => d.metric.startsWith(VISIT_METRIC_PREFIX) && d.verdict === 'fewer');
}
