/**
 * The weekly run, for every household — not one named in an environment
 * variable. Accounts made a household something anyone can create
 * (AGENTS.md INV-8); a week only one of them ever receives is not a product.
 *
 * Each household's week is counted from its own events, stored under its
 * own key and shown on its own television first (INV-7: weekCard.ts).
 * lambda.ts wires the real table, model and egress into this.
 */
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { QueuedCard, WeekNarrative } from '@wick/contracts';
import { computeWeekNarrative, type NarratorDeps } from './index.js';
import type { WeekRange } from './isoWeek.js';
import { buildWeekCard } from './weekCard.js';

export interface EveryHouseholdDeps {
  readonly listHouseholds: () => Promise<readonly string[]>;
  readonly loadEvents: (householdId: string, range: WeekRange) => Promise<readonly Record<string, AttributeValue>[]>;
  /** The household's first recorded event, ever — where its Rhythm baseline can begin. */
  readonly firstEventAt: (householdId: string) => Promise<number | undefined>;
  readonly writeNarrative: NarratorDeps['writeNarrative'];
  readonly saveNarrative: (narrative: WeekNarrative) => Promise<void>;
  readonly sendWeekCard: (card: QueuedCard) => Promise<void>;
  readonly now: () => number;
  readonly newCorrelationId: () => string;
  /** Each home's own clock (store/household.ts loadHouseholdTimeZone): its week is counted in it. */
  readonly timeZoneOf: (householdId: string) => Promise<string>;
  /**
   * The household's family member as the resident knows them, for the week
   * card's "What … sees" button (weekCard.ts familyNameForWeekCard) — asked
   * of each household's own circle, not set once for every home.
   */
  readonly familyNameOf?: (householdId: string) => Promise<string | undefined>;
}

export interface NarratorRun {
  readonly written: readonly string[];
  readonly failed: readonly string[];
}

/**
 * The households a week is written for: those with a paired television
 * (`HH#<household>` / `DEV#<deviceId>`). Pure, so the selection is tested
 * without AWS.
 *
 * A household with no television is left out on purpose. INV-7 says the
 * resident sees the week on their own screen before the family can read
 * it; with no screen that can never happen, so the week would be written,
 * paid for and never readable by anyone.
 */
export function householdsWithTelevision(items: readonly Record<string, AttributeValue>[]): string[] {
  const households = new Set<string>();
  for (const item of items) {
    const pk = item.pk?.S;
    if (pk?.startsWith('HH#') && item.sk?.S?.startsWith('DEV#')) households.add(pk.slice('HH#'.length));
  }
  return [...households];
}

export async function narrateEveryHousehold(isoWeek: string, deps: EveryHouseholdDeps): Promise<NarratorRun> {
  const written: string[] = [];
  const failed: string[] = [];

  for (const householdId of await deps.listHouseholds()) {
    // One household at a time, each on its own: a table error or a broken
    // television in one home must not cost every home after it its week.
    try {
      const narrative = await computeWeekNarrative(householdId, isoWeek, {
        loadEvents: (range) => deps.loadEvents(householdId, range),
        firstEventAt: () => deps.firstEventAt(householdId),
        writeNarrative: deps.writeNarrative,
        now: deps.now,
        timeZone: await deps.timeZoneOf(householdId),
      });
      await deps.saveNarrative(narrative);

      // The resident's copy — INV-7. Pressing its one button is what actually
      // sets residentSeenAt (route.mjs); nothing here does that directly.
      // A circle that cannot be read costs the button its name, never the household its week.
      const familyName = await deps.familyNameOf?.(householdId).catch(() => undefined);
      await deps.sendWeekCard(buildWeekCard(narrative, deps.newCorrelationId(), deps.now(), familyName));
      written.push(householdId);
      console.log(JSON.stringify({ level: 'info', msg: 'narrative_computed', householdId, isoWeek, events: narrative.timeline.length, baselineWeeks: narrative.deltas[0]?.baselineWeeks ?? 0, unusual: narrative.deltas.filter((d) => d.verdict && d.verdict !== 'usual').length, textSource: narrative.textSource, chars: narrative.text.length }));
    } catch (err) {
      failed.push(householdId);
      console.error(JSON.stringify({ level: 'error', msg: 'narrative_household_failed', householdId, isoWeek, error: (err as Error).name || String(err) }));
    }
  }

  return { written, failed };
}
