/**
 * Narrator — the weekly narrative. PRECOMPUTED, never generated in-request.
 *
 * Alexa+ requires MCP round trips under 500ms, so generating a week's prose
 * inside a tool call is not an option. A weekly schedule writes it; the MCP tool
 * (get_week_narrative.ts) does a single GetItem.
 *
 * THE MODEL NEVER COUNTS. Retrieve the timeline (timeline.ts), count it in
 * the household's time zone (weekFacts.ts), and hand only those counted
 * facts to the model for prose (prose.ts). Its prose is then checked: a
 * number the facts never gave, or a narrative too long for the card, is
 * refused, asked for once more, and then replaced by a narrative written
 * from the facts alone.
 *
 * THE MODEL NEVER DECIDES WHAT IS USUAL, either. The six weeks before this
 * one are loaded with it and counted the same way (rhythm/baseline.ts);
 * `deltas` is this week against them. The model is shown last week and the
 * usual week as facts, with the verdict already reached (comparisons.ts),
 * and prose that makes a comparison the facts do not is refused like a
 * wrong number. Below three observed weeks there is no usual week and no
 * verdict: narrative.ts's RhythmDelta says deviations are suppressed below
 * three weeks of baseline, and that is enforced here, not hoped for.
 *
 * residentSeenAt is never set here, on purpose. INV-7: the resident sees
 * their week on their own television before any family surface can read
 * it. lambda.ts sends a WeekCard (weekCard.ts); pressing its one button is
 * what sets residentSeenAt (edge-device route.mjs). Auto-marking it seen at
 * generation time, so get_week_narrative.ts would answer Sarah at once,
 * would be exactly what docs/WICK.md's trust model forbids: saying
 * something to the family before the resident has seen it.
 *
 * Model: Claude — runs weekly, offline, and prose quality IS the product here.
 * See docs/WICK-TECHNICAL.md §5.4.
 */
import { heardHoursOf, type RhythmDelta, type TimelineEntry, type WeekNarrative } from '@wick/contracts';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { isoWeekRange, type WeekRange } from './isoWeek.js';
import { toTimelineEntry } from './timeline.js';
import { checkNarrative, factLines, fallbackNarrative, refusalReason, summariseWeek, unheardDaysOf, type WeekFacts } from './weekFacts.js';
import { comparisonLines } from './comparisons.js';
import { BASELINE_WEEKS, baselineWindow, weekDeltas } from '../../rhythm/baseline.js';

const WEEK_MS = 7 * 86_400_000;

export interface NarratorDeps {
  /** Called once, with the week and the six before it (rhythm/baseline.ts baselineWindow). */
  readonly loadEvents: (range: WeekRange) => Promise<readonly Record<string, AttributeValue>[]>;
  /**
   * When the household's first event was recorded, ever. A week before it
   * is a week nobody saw, not a quiet one, and is kept out of the baseline.
   */
  readonly firstEventAt: () => Promise<number | undefined>;
  /**
   * Prose from the fact lines. `retryReason` is set on the second attempt
   * and says why the first was refused.
   */
  readonly writeNarrative: (facts: readonly string[], retryReason?: string) => Promise<string>;
  readonly now: () => number;
  /** The household's IANA time zone: "Wednesday evening" means theirs. */
  readonly timeZone: string;
}

const MODEL_ATTEMPTS = 2;

export interface WeekCounted {
  readonly timeline: TimelineEntry[];
  readonly facts: WeekFacts;
  readonly deltas: RhythmDelta[];
}

/**
 * The week, counted: its own events, and how they compare with the weeks
 * before. `rawItems` covers baselineWindow(range). No model is involved, so
 * every caller counts the same way.
 */
export function countWeek(
  rawItems: readonly Record<string, AttributeValue>[],
  range: WeekRange,
  when: { readonly now: number; readonly timeZone: string; readonly observedSince: number | undefined },
): WeekCounted {
  const loaded = rawItems
    .map(toTimelineEntry)
    .filter((e): e is TimelineEntry => e !== undefined);
  const timeline = loaded.filter((e) => e.at >= range.startMs && e.at < range.endMs);
  // When the doorbell was heard (packages/contracts heard.ts). Before the first hour on record, Wick was not yet listening.
  const heard = rawItems.flatMap((item) => heardHoursOf(item.sk?.S, item.hours?.NS)).sort((a, b) => a - b);
  const trackedSince = heard[0];
  const facts = summariseWeek(timeline, { timeZone: when.timeZone, range, now: when.now, heard, ...(trackedSince === undefined ? {} : { trackedSince }) });
  const unheardWeeks = Array.from({ length: BASELINE_WEEKS }, (_, i) => i + 1).filter((k) => {
    const earlier = { startMs: range.startMs - k * WEEK_MS, endMs: range.endMs - k * WEEK_MS };
    return unheardDaysOf(earlier, when.timeZone, when.now, heard, trackedSince).length > 0;
  });
  return {
    timeline,
    facts,
    deltas: weekDeltas(loaded, { range, now: when.now, observedSince: when.observedSince, unheardWeeks }),
  };
}

/**
 * A week written from the facts alone — the narrative the Narrator falls
 * back to, asked for directly. For a history that has to exist the moment a
 * household does (the demo home, services/mcp-server/src/accounts/
 * demoHome.ts): there is no Sunday evening to wait for, and no reason to
 * pay a model to phrase a week nobody lived.
 *
 * `rawItems` are EVT# items covering the week and the six before it.
 */
export function factsWeekNarrative(
  householdId: string,
  isoWeek: string,
  rawItems: readonly Record<string, AttributeValue>[],
  when: { readonly now: number; readonly timeZone: string; readonly observedSince: number | undefined },
): WeekNarrative {
  const { timeline, facts, deltas } = countWeek(rawItems, isoWeekRange(isoWeek), when);
  return { householdId, isoWeek, text: fallbackNarrative(facts, deltas), textSource: 'facts', deltas, timeline, ...unheardOf(facts), generatedAt: when.now };
}

export async function computeWeekNarrative(
  householdId: string,
  isoWeek: string,
  deps: NarratorDeps,
): Promise<WeekNarrative> {
  const range = isoWeekRange(isoWeek);
  const rawItems = await deps.loadEvents(baselineWindow(range));
  const { timeline, facts, deltas } = countWeek(rawItems, range, {
    now: deps.now(),
    timeZone: deps.timeZone,
    observedSince: await deps.firstEventAt(),
  });
  const lines = [...factLines(facts), ...comparisonLines(deltas, facts.weekComplete, facts.unheardDays.length > 0)];

  let text: string | undefined;
  let retryReason: string | undefined;
  for (let attempt = 0; attempt < MODEL_ATTEMPTS && text === undefined; attempt += 1) {
    let draft: string;
    try {
      draft = (await deps.writeNarrative(lines, retryReason)).trim();
    } catch (err) {
      // A model outage must not silence the week: the facts can speak for themselves.
      console.error(JSON.stringify({ level: 'error', msg: 'narrative_model_failed', isoWeek, error: (err as Error).name || String(err) }));
      break;
    }
    const check = checkNarrative(draft, facts, deltas);
    if (check.ok) text = draft;
    else {
      retryReason = refusalReason(check);
      console.warn(JSON.stringify({ level: 'warn', msg: 'narrative_rejected', isoWeek, attempt, reason: check.reason, detail: check.detail }));
    }
  }

  return {
    householdId,
    isoWeek,
    text: text ?? fallbackNarrative(facts, deltas),
    textSource: text === undefined ? 'facts' : 'model',
    deltas,
    timeline,
    ...unheardOf(facts),
    generatedAt: deps.now(),
  };
}

/** The unheard days, kept with the week so that every later telling of it says the same (WeekNarrative.unheardDays). */
export function unheardOf(facts: WeekFacts): Pick<WeekNarrative, 'unheardDays'> {
  return facts.unheardDays.length > 0 ? { unheardDays: facts.unheardDays } : {};
}
