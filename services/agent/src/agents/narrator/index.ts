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
 * from the facts alone. deltas is
 * always empty: S6 Rhythm's baseline — the thing "up from last week" would
 * be computed from — does not exist yet (no Timestream table, no baseline
 * job). Reporting zero deltas is the honest answer, not a placeholder:
 * narrative.ts's own RhythmDelta comment says deviations are suppressed
 * below three weeks of baseline, and zero is below three.
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
import type { TimelineEntry, WeekNarrative } from '@wick/contracts';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { isoWeekRange, type WeekRange } from './isoWeek.js';
import { toTimelineEntry } from './timeline.js';
import { checkNarrative, factLines, fallbackNarrative, summariseWeek } from './weekFacts.js';

export interface NarratorDeps {
  readonly loadEvents: (range: WeekRange) => Promise<readonly Record<string, AttributeValue>[]>;
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

export async function computeWeekNarrative(
  householdId: string,
  isoWeek: string,
  deps: NarratorDeps,
): Promise<WeekNarrative> {
  const range = isoWeekRange(isoWeek);
  const rawItems = await deps.loadEvents(range);
  const timeline = rawItems
    .map(toTimelineEntry)
    .filter((e): e is TimelineEntry => e !== undefined);

  const facts = summariseWeek(timeline, { timeZone: deps.timeZone, range, now: deps.now() });
  const lines = factLines(facts);

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
    const check = checkNarrative(draft, facts);
    if (check.ok) text = draft;
    else {
      retryReason = check.reason === 'unsupported_number'
        ? `Your draft used "${check.detail}", a number that is not in the facts. Use only the numbers given.`
        : check.reason === 'too_long'
          ? `Your draft was ${check.detail} characters. Stay under the limit.`
          : 'Your draft was empty.';
      console.warn(JSON.stringify({ level: 'warn', msg: 'narrative_rejected', isoWeek, attempt, reason: check.reason, detail: check.detail }));
    }
  }

  return {
    householdId,
    isoWeek,
    text: text ?? fallbackNarrative(facts),
    textSource: text === undefined ? 'facts' : 'model',
    deltas: [],
    timeline,
    generatedAt: deps.now(),
  };
}
