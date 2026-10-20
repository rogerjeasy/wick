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
 * With one exception: the most recent morning Maria was due, she did not
 * come, and she has not been since. It is the one thing in this home that
 * is unlike its usual, so that the television has something to ask the
 * resident about — "Shall I tell …?" (services/agent agents/tell) — and the
 * family something to be told (rhythm/different.ts).
 *
 * There is always exactly one. Early in a week, before her first morning
 * is over, the morning she missed is last Friday, and last week's story is
 * written from the same rows — one visit, not two — so the story and the
 * timeline cannot disagree. It used to be looked for in the current week
 * only, which left a home made on a Monday with nothing different in it:
 * a guest who arrived then was never asked anything.
 *
 * The visits Maria did make in the last fortnight are on record too (The
 * visit, witnessed — packages/contracts visit.ts): the VISIT# rows the
 * Door agent opens, each with the leaving the door would have noted and
 * the resident's "Yes, that's right", so that "were this week's visits
 * confirmed?" has an answer. All of them are confirmed, and none is left
 * for the television to ask about. That is not a choice but a consequence
 * of the paragraph above: the morning she missed, and any since, are left
 * out, so the latest visit there is to seed is always at least three days
 * old — and a visit is only asked about within a day of it (visit.ts
 * `readyToAsk`). A visit recent enough to ask about would have to be
 * Maria's, which would make "she did not come" untrue, or somebody else's,
 * and this home has no other regular visitor: adding one would change what
 * the door, the week's story and Something's Different say of it. In a
 * demo home the question "Is this right?" comes from a real ring at the
 * door, as in any other.
 *
 * Deterministic: the same moment gives the same history. Only events that
 * have already happened are written, so "today" is as true at nine in the
 * morning as at nine at night.
 */
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { VISIT_SETTLED_MS, currentIsoWeek, padTimestamp, parseTimestampFromSortKey, type RosterEntry, type WeekNarrative } from '@wick/contracts';
import { VISIT_GRACE_MS, briefMessage, factsWeekNarrative, isoWeekRange, parsePattern, visitItem } from '@wick/agent';
import { wallClockAsUtc, wallClockToMoment } from '../tools/when.js';

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

/** The demo home's regular visitor. Times are the house's own, as the Door agent matches them (door/roster.ts). */
export const DEMO_VISITOR: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' };

/** How far back the demo home's visits are on record, as visits the resident confirmed (packages/contracts visit.ts). */
export const DEMO_VISIT_RECORD_DAYS = 14;

/**
 * How long the history is kept. A demo home costs one click and no email,
 * and its history is some seventy rows: left for ever, the demo
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

/** How long a simulated visit lasted: forty-five to fifty-five minutes, a different length from one visit to the next. Never random. */
const stayedMinutes = (weeksAgo: number, slot: number): number => 45 + ((weeksAgo * 3 + slot * 2) % 11);
/** How long after the leaving had stood the simulated resident was at the television, and how long she took to answer. */
const ASKED_AFTER_SETTLED_MS = 15 * MINUTE;
const ANSWERED_AFTER_MS = 2 * MINUTE;

/**
 * A visit of the demo home's, as the Door agent's own row (services/agent
 * store/visits.ts): the leaving the door would have noted, the question,
 * and the resident's "Yes, that's right". Undefined for a visit whose
 * answer would not have been given yet — nothing is written that has not
 * happened.
 */
function confirmedVisitItem(householdId: string, visitor: RosterEntry, arrivedAt: number, stayedMin: number, now: number): Item | undefined {
  const leftAt = arrivedAt + stayedMin * MINUTE;
  const askedAt = leftAt + VISIT_SETTLED_MS + ASKED_AFTER_SETTLED_MS;
  const answeredAt = askedAt + ANSWERED_AFTER_MS;
  if (answeredAt > now) return undefined;
  return visitItem({ householdId, personId: visitor.personId, name: visitor.name, arrivedAt, leftAt, askedAt, answer: 'confirmed', answeredAt, simulated: true });
}

/**
 * The week is laid out on the house's own clock: `thisMonday` is Monday's
 * midnight written as if it were UTC, and every time from it is turned into
 * the moment it is where the house is (when.ts wallClockToMoment). So Maria
 * comes at nine in the morning in Seattle as in London, never at two.
 */
const onTheHouseClock = (wallClock: number, timeZone: string): number => wallClockToMoment(wallClock, timeZone);

/** When Maria is due in a given week: the start of her window on that slot's day, without the jitter. */
const dueAt = (thisMonday: number, weeksAgo: number, slot: Slot, minuteOfDay: number, timeZone: string): number =>
  onTheHouseClock(thisMonday - weeksAgo * WEEK + slot.day * DAY + minuteOfDay * MINUTE, timeZone);

/**
 * The morning Maria did not come: the latest one that is over by the rule
 * Something's Different itself uses (her window, and the grace after it),
 * so the home never claims a visit was missed while she could still be on
 * her way. Returned as the moment she was due.
 *
 * It is looked for in this week and, early in the week, in the last one —
 * so there is always one. A home made on a Monday used to have nothing
 * different in it until Tuesday's grace ran out, and a guest who arrived
 * then was never asked "Shall I tell …?" at all.
 */
function missedVisitDueAt(thisMonday: number, now: number, timeZone: string): number | undefined {
  const pattern = parsePattern(DEMO_VISITOR.expectedPattern);
  if (!pattern) return undefined;
  let missed: number | undefined;
  for (const weeksAgo of [1, 0]) {
    for (const slot of WEEK_PATTERN) {
      if (!slot.visitor) continue;
      const due = dueAt(thisMonday, weeksAgo, slot, pattern.minuteOfDay, timeZone);
      if (due + pattern.windowMin * MINUTE + VISIT_GRACE_MS <= now) missed = due;
    }
  }
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
  // This week's Monday where the house is, on its wall clock (onTheHouseClock).
  const thisMonday = isoWeekRange(currentIsoWeek(new Date(wallClockAsUtc(now, timeZone)))).startMs;

  const visitorMinuteOfDay = parsePattern(DEMO_VISITOR.expectedPattern)?.minuteOfDay ?? 0;
  const missed = missedVisitDueAt(thisMonday, now, timeZone);

  const events: Item[] = [];
  const visits: Item[] = [];
  const recordedSince = now - DEMO_VISIT_RECORD_DAYS * DAY;
  for (let weeksAgo = FIRST_WEEK_AGO; weeksAgo >= 0; weeksAgo -= 1) {
    WEEK_PATTERN.forEach((slot, index) => {
      if (slot.inWeek && !slot.inWeek(weeksAgo)) return;
      // The morning she missed, and any since: she has not come again yet.
      // A visit after it would make "she did not come" untrue — the detector
      // counts coming late, or on a later day, as having come.
      if (slot.visitor && missed !== undefined && dueAt(thisMonday, weeksAgo, slot, visitorMinuteOfDay, timeZone) >= missed) return;
      const at = onTheHouseClock(thisMonday - weeksAgo * WEEK + slot.day * DAY + slot.hour * HOUR + (slot.minute + jitterMinutes(weeksAgo, index)) * MINUTE, timeZone);
      if (at > now) return;
      events.push(...eventItems(householdId, at, `${weeksAgo}-${index}`, slot.visitor));
      // The visit, witnessed: a visit she made lately is one the resident has confirmed.
      const visit = slot.visitor && at >= recordedSince ? confirmedVisitItem(householdId, slot.visitor, at, stayedMinutes(weeksAgo, index), now) : undefined;
      if (visit) visits.push(visit);
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
      // With the visits she confirmed: only those say who came (packages/contracts visit.ts).
      ...factsWeekNarrative(householdId, isoWeek, [...events, ...visits], { now: narratedAt, timeZone, observedSince }),
      residentSeenAt: narratedAt + READ_AFTER_MS,
      simulated: true,
    };
    weeks.push({ pk, sk: { S: `NARR#${isoWeek}` }, data: { S: JSON.stringify(narrative) } });
  }

  const ttl = { N: String(Math.floor((now + DEMO_HISTORY_TTL_MS) / 1000)) };
  const films = demoFilmItems(householdId, thisMonday, timeZone);
  const roster: Item = { pk, sk: { S: `PER#${DEMO_VISITOR.personId}` }, data: { S: JSON.stringify(DEMO_VISITOR) } };
  // The demo home's own expiry, on every row: a visit's row would otherwise keep its thirteen months (store/visits.ts).
  return [roster, ...events, ...weeks, ...visits, ...films].map((item) => ({ ...item, ttl }));
}

/** The demo home's television, as the rhythm rows name it. */
export const DEMO_TELEVISION = 'demo-television';

/** When, last week, a film was played: Wednesday evening and Saturday afternoon (day from Monday, hour). */
const FILM_TIMES: readonly { readonly day: number; readonly hour: number }[] = [
  { day: 2, hour: 19 },
  { day: 5, hour: 15 },
];

const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * Last week, a film was played on her television: the rhythm rows the
 * television's PLAYING writes (edge-device device-event.mjs
 * tvActivityKey), simulated like the rest. Only the Sunday brief reads them
 * (agents/brief/facts.ts watchedFilms), and they are what lets its
 * suggester offer "Watch a film together" — so the demo's week can end
 * with one thing to do, as a real week of films would.
 */
function demoFilmItems(householdId: string, thisMonday: number, timeZone: string): Item[] {
  return FILM_TIMES.map(({ day, hour }) => {
    const at = onTheHouseClock(thisMonday - WEEK + day * DAY + hour * HOUR, timeZone);
    // Bucketed in UTC, as the television's own rows are (edge-device device-event.mjs tvActivityKey).
    const d = new Date(at);
    const bucket = `${DOW[d.getUTCDay()]}-${String(d.getUTCHours()).padStart(2, '0')}`;
    return {
      pk: { S: `HH#${householdId}` },
      sk: { S: `RHYTHM#tv_activity#${DEMO_TELEVISION}#power_on#${bucket}` },
      count: { N: '1' },
      lastSeenAt: { N: String(at) },
      simulated: { BOOL: true },
    };
  });
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

/** The newest week a demo home has a story for: the last whole week before the one it was made in (demoHomeItems). */
export function newestDemoWeek(now: number): string {
  return currentIsoWeek(new Date(isoWeekRange(currentIsoWeek(new Date(now))).startMs - WEEK));
}

/**
 * Asks Wick's agents to write the demo home's newest week again — the
 * Sunday brief, on AgentCore (services/agent graphs/weeklyBrief.ts) — so a
 * guest who asks "How has Mum been?" reads a week the agents wrote, with
 * the one thing they could do about it. It goes on the brief's queue as a
 * demo home's (`origin: 'demo'`): the worker never falls back to the
 * Narrator for it, since the week is already there. The week stays
 * simulated, and stays read (agents/brief/store.ts).
 *
 * Asked, never waited for: the guest is made, and the week they first read
 * is the facts' until the agents' replaces it. A queue that cannot be
 * reached is logged and let go — a demo is never refused for it.
 */
export async function requestDemoBrief(send: (body: string) => Promise<unknown>, householdId: string, now: number): Promise<string | undefined> {
  const isoWeek = newestDemoWeek(now);
  try {
    await send(briefMessage({ householdId, isoWeek, origin: 'demo' }));
    return isoWeek;
  } catch (err) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'demo_brief_not_requested', householdId, error: (err as Error).name || String(err) }));
    return undefined;
  }
}
