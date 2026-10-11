/**
 * The demo home's history: six weeks of a house to ask about, there from
 * the first minute.
 *
 * A guest's home used to be empty. Every question a visitor tried — how the
 * week has been, whether Maria came, what happened today — was answered
 * with "nothing yet", because Wick only knows what has happened at a door,
 * and nobody had been to this one. A product about the shape of somebody's
 * week cannot be shown on a home with no weeks.
 *
 * So the demo home is given one, and it is SIMULATED — the one place in
 * Wick where runtime data is not something that happened (AGENTS.md, Data
 * rules). Three things keep that honest:
 *
 *   - It is marked. Every event row and every week carries `simulated`, the
 *     household does too (types.ts), and the family app says so wherever it
 *     names the home.
 *   - It is only ever written to a demo home, when a guest is made
 *     (accountRouter.ts startDemo). No real household is given a history.
 *   - It is made of the same rows the product writes — the Door agent's own
 *     door and presence events (services/agent/src/agents/door/
 *     presence.ts) — and the weeks are counted from them by the Narrator's
 *     own code, with no model. Nothing downstream knows a special case:
 *     the tools, the Rhythm baseline and Sunday's Narrator read this home
 *     exactly as they read any other.
 *
 * The house it describes is an ordinary one, on purpose. Maria, a carer,
 * comes on Tuesday and Friday mornings; there is post, a delivery, a caller
 * at the weekend. Last week was like the weeks before it, so its story ends
 * the way Wick's best weeks do: nothing unusual.
 *
 * With one exception, in the week still under way: the most recent morning
 * Maria was due, she did not come. It is the one thing in this home that
 * is unlike its usual, so that "is anything different?" has something to
 * find (rhythm/different.ts) — said once, calmly, and gone again when she
 * next comes. Early in a week, before her first morning is over, there is
 * nothing different at all, which is the commoner answer.
 *
 * Deterministic: the same moment gives the same history. Only events that
 * have already happened are written, so "today" is as true at nine in the
 * morning as at nine at night.
 */
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { currentIsoWeek, padTimestamp, parseTimestampFromSortKey, type RosterEntry, type WeekNarrative } from '@wick/contracts';
import { VISIT_GRACE_MS, factsWeekNarrative, isoWeekRange, parsePattern } from '@wick/agent';

type Item = Record<string, AttributeValue>;

/** Whole weeks a usual week is drawn from, before the current one (rhythm/baseline.ts BASELINE_WEEKS). */
export const DEMO_HISTORY_WEEKS = 6;
/**
 * The week Wick was set up in. A week only counts towards a usual week if
 * Wick was already watching on its Monday, and the first event of any
 * history comes some hours into one — so the history starts a week before
 * the six it is measured against, exactly as a real home's would.
 */
const FIRST_WEEK_AGO = DEMO_HISTORY_WEEKS + 1;

/** The demo home's regular visitor. Times are UTC, as the Door agent matches them (door/roster.ts). */
export const DEMO_VISITOR: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' };

/**
 * How long the history is kept. A demo home costs one click and no email,
 * and its history is some seventy-five rows: left for ever, the demo
 * button would be a way to grow the table without limit. Every row carries
 * the table's own expiry (infra/core.tf `ttl`), sixty days on — past the
 * end of judging for a home made on the last day. The guest rate limit
 * (demo.ts) bounds how fast they can be made; this bounds how many exist.
 */
export const DEMO_HISTORY_TTL_MS = 60 * 24 * 60 * 60 * 1000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** When the Narrator runs (infra/narrator.tf: Sunday 20:00 UTC), measured back from the week's end. */
const NARRATED_BEFORE_WEEK_END_MS = 4 * HOUR;
/** How long the simulated resident took to read each week on the television. */
const READ_AFTER_MS = 35 * MINUTE;

interface Slot {
  /** Days after Monday. */
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly visitor?: RosterEntry;
  /** Which weeks have it; every week when absent. `weeksAgo` is 0 for the current week. */
  readonly inWeek?: (weeksAgo: number) => boolean;
}

const WEEK_PATTERN: readonly Slot[] = [
  { day: 0, hour: 10, minute: 40 },
  { day: 1, hour: 9, minute: 0, visitor: DEMO_VISITOR },
  { day: 2, hour: 15, minute: 10 },
  { day: 3, hour: 11, minute: 25, inWeek: (weeksAgo) => weeksAgo % 2 === 0 },
  { day: 4, hour: 9, minute: 0, visitor: DEMO_VISITOR },
  { day: 5, hour: 10, minute: 50 },
  { day: 6, hour: 12, minute: 30, inWeek: (weeksAgo) => weeksAgo % 3 !== 0 },
];

/** A few minutes either way, so no two weeks are the same to the minute. Never random. */
const jitterMinutes = (weeksAgo: number, slot: number): number => ((weeksAgo * 7 + slot * 5) % 25) - 12;

function eventItems(householdId: string, at: number, key: string, visitor: RosterEntry | undefined): Item[] {
  const pk = { S: `HH#${householdId}` };
  const door: Item = { pk, sk: { S: `EVT#${padTimestamp(at)}#demo-door-${key}` }, type: { S: 'door' }, simulated: { BOOL: true } };
  if (!visitor) return [door];
  return [door, {
    pk,
    sk: { S: `EVT#${padTimestamp(at)}#demo-visit-${key}` },
    type: { S: 'presence' },
    personId: { S: visitor.personId },
    personName: { S: visitor.name },
    simulated: { BOOL: true },
  }];
}

/**
 * Which of this week's visits did not happen: the latest one that is over
 * by the rule Something's Different itself uses (her window, and the grace
 * after it), so the home never claims a visit was missed while she could
 * still be on her way. Undefined before her first morning of the week.
 */
function missedVisitSlot(thisMonday: number, now: number): number | undefined {
  const pattern = parsePattern(DEMO_VISITOR.expectedPattern);
  if (!pattern) return undefined;
  let missed: number | undefined;
  WEEK_PATTERN.forEach((slot, index) => {
    if (!slot.visitor) return;
    const over = thisMonday + slot.day * DAY + (pattern.minuteOfDay + pattern.windowMin) * MINUTE + VISIT_GRACE_MS;
    if (over <= now) missed = index;
  });
  return missed;
}

/**
 * Everything the demo home starts with: the roster, the events of the
 * whole weeks before this one and of this week so far, and each whole
 * week's story, already read by the resident (INV-7 holds: they saw it
 * first).
 */
export function demoHomeItems(householdId: string, now: number, timeZone: string): Item[] {
  const pk = { S: `HH#${householdId}` };
  const thisMonday = isoWeekRange(currentIsoWeek(new Date(now))).startMs;

  const missed = missedVisitSlot(thisMonday, now);

  const events: Item[] = [];
  for (let weeksAgo = FIRST_WEEK_AGO; weeksAgo >= 0; weeksAgo -= 1) {
    WEEK_PATTERN.forEach((slot, index) => {
      if (slot.inWeek && !slot.inWeek(weeksAgo)) return;
      if (weeksAgo === 0 && index === missed) return;
      const at = thisMonday - weeksAgo * WEEK + slot.day * DAY + slot.hour * HOUR + (slot.minute + jitterMinutes(weeksAgo, index)) * MINUTE;
      if (at <= now) events.push(...eventItems(householdId, at, `${weeksAgo}-${index}`, slot.visitor));
    });
  }

  // As the Narrator finds it for any home: the household's first event (narrator/lambda.ts firstEventAt).
  const observedSince = parseTimestampFromSortKey(events[0]!.sk!.S!);
  const weeks: Item[] = [];
  for (let weeksAgo = FIRST_WEEK_AGO; weeksAgo >= 1; weeksAgo -= 1) {
    const weekStart = thisMonday - weeksAgo * WEEK;
    const isoWeek = currentIsoWeek(new Date(weekStart));
    const narratedAt = weekStart + WEEK - NARRATED_BEFORE_WEEK_END_MS;
    const narrative: WeekNarrative = {
      ...factsWeekNarrative(householdId, isoWeek, events, { now: narratedAt, timeZone, observedSince }),
      residentSeenAt: narratedAt + READ_AFTER_MS,
      simulated: true,
    };
    weeks.push({ pk, sk: { S: `NARR#${isoWeek}` }, data: { S: JSON.stringify(narrative) } });
  }

  const ttl = { N: String(Math.floor((now + DEMO_HISTORY_TTL_MS) / 1000)) };
  const roster: Item = { pk, sk: { S: `PER#${DEMO_VISITOR.personId}` }, data: { S: JSON.stringify(DEMO_VISITOR) } };
  return [roster, ...events, ...weeks].map((item) => ({ ...item, ttl }));
}

const WRITES_AT_ONCE = 10;

/**
 * Writes the history, a few rows at a time. A row that fails is logged and
 * left out: a history with one event missing is still a history, and a
 * guest must never be refused a demo because a write was throttled.
 */
export async function seedDemoHome(
  put: (item: Item) => Promise<unknown>,
  householdId: string,
  now: number,
  timeZone: string,
): Promise<void> {
  const items = demoHomeItems(householdId, now, timeZone);
  let failed = 0;
  for (let i = 0; i < items.length; i += WRITES_AT_ONCE) {
    const results = await Promise.allSettled(items.slice(i, i + WRITES_AT_ONCE).map((item) => put(item)));
    failed += results.filter((r) => r.status === 'rejected').length;
  }
  if (failed) console.warn(JSON.stringify({ level: 'warn', msg: 'demo_home_rows_failed', householdId, failed, of: items.length }));
}
