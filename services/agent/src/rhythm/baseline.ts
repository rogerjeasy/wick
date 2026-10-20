/**
 * S6 — the Rhythm baseline: what a usual week looks like in this house, so
 * the weekly narrative can say "nothing unusual" and mean it (§8.2, §5.4).
 *
 * Counted from the household's own timeline (the same EVT# rows the week is
 * written from), week by week, over the six weeks before this one. The
 * RHYTHM# bucket counters (records.ts) cannot give this: they add every
 * week into one number per day-of-week and hour, so they say when the door
 * is usually busy, never how busy last week was.
 *
 * Three rules keep it honest:
 *
 *   - A week only counts if Wick was already watching on its Monday. The
 *     weeks before a household's first recorded event are not quiet weeks,
 *     they are weeks nobody saw.
 *   - A week that is not over is compared with the same stretch of the
 *     weeks before it — Monday to Wednesday noon against Monday to
 *     Wednesday noon — never with their whole.
 *   - No verdict from fewer than three weeks (§8.2: "a false 'something's
 *     different' is worse than the feature's absence"), and never for
 *     differing from the usual by a single event: the spread a week is
 *     measured against is the household's own, but at least one.
 *
 * Pure: no AWS, no model. The model never counts (§5.4), and it never
 * decides what is unusual either.
 */
import type { RhythmDelta, TimelineEntry } from '@wick/contracts';

/** How far back a usual week is drawn from. §8.2: "a trailing 4–6 weeks". */
export const BASELINE_WEEKS = 6;
/** Below this many observed weeks there is a last week, but no usual one. */
export const MIN_BASELINE_WEEKS = 3;
/** How many spreads from the usual a week must be before it is called unusual. */
export const UNUSUAL_Z = 2;
/** A week one event away from a steady pattern is never unusual. */
const MIN_SPREAD = 1;

const WEEK_MS = 7 * 86_400_000;

export const DOOR_METRIC = 'door';
export const VISIT_METRIC_PREFIX = 'visit:';

export interface WeekSpan {
  readonly startMs: number;
  /** Exclusive. */
  readonly endMs: number;
}

export interface MetricWeeks {
  readonly metric: string;
  readonly label: string;
  readonly thisWeek: number;
  /** Observed weeks before this one, most recent first. */
  readonly priorWeeks: readonly number[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function deltaFor(input: MetricWeeks): RhythmDelta {
  const { metric, label, thisWeek, priorWeeks } = input;
  const n = priorWeeks.length;
  const mean = n === 0 ? 0 : priorWeeks.reduce((sum, c) => sum + c, 0) / n;
  const [lastWeek] = priorWeeks;
  const base = { metric, label, thisWeek, baseline: round2(mean), baselineWeeks: n, ...(lastWeek !== undefined ? { lastWeek } : {}) };

  if (n < MIN_BASELINE_WEEKS) return { ...base, zScore: 0 };

  const variance = priorWeeks.reduce((sum, c) => sum + (c - mean) ** 2, 0) / (n - 1);
  const zScore = (thisWeek - mean) / Math.max(Math.sqrt(variance), MIN_SPREAD);
  const verdict = zScore >= UNUSUAL_Z ? 'more' : zScore <= -UNUSUAL_Z ? 'fewer' : 'usual';
  return { ...base, zScore: round2(zScore), verdict };
}

/** Everything the baseline is counted from: the six weeks before, and the week itself. */
export function baselineWindow(range: WeekSpan): WeekSpan {
  return { startMs: range.startMs - BASELINE_WEEKS * WEEK_MS, endMs: range.endMs };
}

export interface RhythmWindow {
  readonly range: WeekSpan;
  readonly now: number;
  /** The household's first recorded event, ever. Absent when there is none. */
  readonly observedSince: number | undefined;
  /**
   * The weeks before this one (1 = last week) with a day the doorbell was not
   * heard (packages/contracts heard.ts). They are left out of the usual: a
   * week Wick could not see is not a quiet week.
   */
  readonly unheardWeeks?: readonly number[];
}

/**
 * A visitor's metric counts the door when they were expected (`presence`),
 * the one signal every week has: how often somebody came then, never who.
 * Its words say so (comparisons.ts). A confirmed visit is told on its own
 * (weekFacts.ts), not counted twice here.
 */
function metricOf(entry: TimelineEntry): { metric: string; label: string } | undefined {
  if (entry.kind === 'door') return { metric: DOOR_METRIC, label: 'the front door' };
  if (entry.kind !== 'presence') return undefined;
  const name = entry.name;
  if (!name) return undefined;
  return { metric: `${VISIT_METRIC_PREFIX}${entry.personId ?? name}`, label: name };
}

/**
 * This week against the weeks before it: the front door first, then each
 * named visitor seen in any of those weeks. `entries` may cover the whole
 * baselineWindow or more; anything outside it is ignored.
 */
export function weekDeltas(entries: readonly TimelineEntry[], window: RhythmWindow): RhythmDelta[] {
  const { range, now, observedSince } = window;
  const elapsed = Math.max(0, Math.min(now, range.endMs) - range.startMs);

  // Week 0 is this one; week k began k weeks before it.
  const observed: number[] = [0];
  for (let k = 1; k <= BASELINE_WEEKS; k += 1) {
    if (observedSince === undefined || observedSince > range.startMs - k * WEEK_MS) break;
    observed.push(k);
  }

  const counts = new Map<string, { label: string; weeks: number[] }>();
  counts.set(DOOR_METRIC, { label: 'the front door', weeks: observed.map(() => 0) });

  for (const entry of entries) {
    const found = metricOf(entry);
    if (!found) continue;
    const k = Math.floor((range.endMs - 1 - entry.at) / WEEK_MS);
    if (entry.at >= range.endMs || k >= observed.length) continue;
    if (entry.at - (range.startMs - k * WEEK_MS) >= elapsed) continue;

    let metric = counts.get(found.metric);
    if (!metric) counts.set(found.metric, (metric = { label: found.label, weeks: observed.map(() => 0) }));
    metric.weeks[k]! += 1;
  }

  const unheard = new Set(window.unheardWeeks ?? []);
  const deltas = [...counts].map(([metric, { label, weeks }]) => {
    const [thisWeek = 0, ...prior] = weeks;
    const priorWeeks = prior.filter((_, i) => !unheard.has(i + 1));
    return deltaFor({ metric, label, thisWeek, priorWeeks });
  });
  const [doorDelta, ...visitors] = deltas;
  return [doorDelta!, ...visitors.sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''))];
}
