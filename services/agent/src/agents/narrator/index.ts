/**
 * Narrator — the weekly narrative. PRECOMPUTED, never generated in-request.
 *
 * Alexa+ requires MCP round trips under 500ms, so generating a week's prose
 * inside a tool call is not an option. A weekly schedule writes it; the MCP tool
 * (get_week_narrative.ts) does a single GetItem.
 *
 * THE MODEL NEVER COUNTS. Retrieve the timeline (timeline.ts) and hand the
 * already-computed facts to the model for prose (prose.ts). deltas is
 * always empty: S6 Rhythm's baseline — the thing "up from last week" would
 * be computed from — does not exist yet (no Timestream table, no baseline
 * job). Reporting zero deltas is the honest answer, not a placeholder:
 * narrative.ts's own RhythmDelta comment says deviations are suppressed
 * below three weeks of baseline, and zero is below three.
 *
 * residentSeenAt is never set here, on purpose. INV-7: the resident sees
 * their week on their own television before any family surface can read
 * it, and no such display surface is built yet — there is no card type or
 * UI for "show the weekly narrative" (Card is DoorCard | DayCard |
 * MessageCard). Auto-marking this seen at generation time, so
 * get_week_narrative.ts would immediately answer Sarah, would be exactly
 * the thing docs/WICK.md's trust model forbids: saying something to the
 * family before the resident has actually seen it. This writes a real,
 * computed narrative and stops there — honestly incomplete rather than
 * quietly wrong.
 *
 * Model: Claude — runs weekly, offline, and prose quality IS the product here.
 * See docs/WICK-TECHNICAL.md §5.4.
 */
import type { TimelineEntry, WeekNarrative } from '@wick/contracts';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { isoWeekRange, type WeekRange } from './isoWeek.js';
import { toTimelineEntry } from './timeline.js';

export interface NarratorDeps {
  readonly loadEvents: (range: WeekRange) => Promise<readonly Record<string, AttributeValue>[]>;
  readonly writeNarrative: (entries: readonly TimelineEntry[]) => Promise<string>;
  readonly now: () => number;
}

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

  const text = await deps.writeNarrative(timeline);

  return {
    householdId,
    isoWeek,
    text,
    deltas: [],
    timeline,
    generatedAt: deps.now(),
  };
}
