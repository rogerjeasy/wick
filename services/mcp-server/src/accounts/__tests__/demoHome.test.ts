import { describe, expect, it } from 'vitest';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { MAX_NARRATIVE_CHARS, VISIT_ASK_WITHIN_MS, VISIT_SETTLED_MS, VISIT_SK_PREFIX, currentIsoWeek, parseTimestampFromSortKey, readyToAsk, type RosterEntry, type Visit, type WeekNarrative } from '@wick/contracts';
import { factsWeekNarrative, isoWeekRange, toTimelineEntry, visitFromItem, whatsDifferent } from '@wick/agent';
import { DEMO_HISTORY_TTL_MS, DEMO_HISTORY_WEEKS, DEMO_VISITOR, DEMO_VISIT_RECORD_DAYS, demoHomeItems, seedDemoHome } from '../demoHome.js';

type Item = Record<string, AttributeValue>;

const DAY = 86_400_000;
const WEEK = 7 * DAY;
// Wednesday 14 October 2026, 15:00 UTC — the middle of 2026-W42.
const NOW = Date.UTC(2026, 9, 14, 15);
const W42 = isoWeekRange('2026-W42');
const HH = 'hh_demo';
/** The history starts in the week before the six a usual week is drawn from. */
const FIRST_WEEK = DEMO_HISTORY_WEEKS + 1;

const items = demoHomeItems(HH, NOW, 'Europe/London');
const events = items.filter((i) => i.sk!.S!.startsWith('EVT#'));
const at = (item: Item): number => parseTimestampFromSortKey(item.sk!.S!);
const narratives = items
  .filter((i) => i.sk!.S!.startsWith('NARR#'))
  .map((i) => JSON.parse(i.data!.S!) as WeekNarrative);

describe('the demo home — a history to ask about, from the first minute', () => {
  it('files every row under the demo home and no other', () => {
    expect(items.length).toBeGreaterThan(40);
    expect(new Set(items.map((i) => i.pk!.S))).toEqual(new Set([`HH#${HH}`]));
  });

  it('puts Maria on the roster, with the days she comes', () => {
    const roster = items.find((i) => i.sk!.S === `PER#${DEMO_VISITOR.personId}`);

    expect(JSON.parse(roster!.data!.S!) as RosterEntry).toEqual({ personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' });
  });

  it('covers the week Wick was set up in, the six whole weeks since, and this week as far as it has gone', () => {
    const times = events.map(at);

    expect(Math.min(...times)).toBeGreaterThanOrEqual(W42.startMs - FIRST_WEEK * WEEK);
    expect(Math.min(...times)).toBeLessThan(W42.startMs - DEMO_HISTORY_WEEKS * WEEK);
    // Nothing is recorded that has not happened yet.
    expect(Math.max(...times)).toBeLessThanOrEqual(NOW);
    expect(times.some((t) => t >= W42.startMs)).toBe(true);
    for (let k = 1; k <= FIRST_WEEK; k += 1) {
      expect(times.filter((t) => t >= W42.startMs - k * WEEK && t < W42.startMs - (k - 1) * WEEK).length).toBeGreaterThanOrEqual(5);
    }
  });

  it('has Maria come every Tuesday and Friday morning of the weeks before this one, inside the time she is expected', () => {
    const visits = events.filter((i) => i.type!.S === 'presence');

    // Two visits in every whole week. This week's Tuesday is the one she missed (see below).
    expect(visits).toHaveLength(FIRST_WEEK * 2);
    for (const visit of visits) {
      const when = new Date(at(visit));
      expect(visit.personId!.S).toBe('maria');
      expect(visit.personName!.S).toBe('Maria');
      expect([2, 5]).toContain(when.getUTCDay());
      expect(Math.abs(when.getUTCHours() * 60 + when.getUTCMinutes() - 9 * 60)).toBeLessThanOrEqual(30);
      // A visit is also someone at the door, as the Door agent records it.
      expect(events.some((e) => e.type!.S === 'door' && at(e) === at(visit))).toBe(true);
    }
  });

  it('gives no two rows the same key', () => {
    expect(new Set(items.map((i) => i.sk!.S)).size).toBe(items.length);
  });

  it('marks every event and every week as simulated — nobody lived these weeks', () => {
    expect(events.every((i) => i.simulated?.BOOL === true)).toBe(true);
    expect(items.filter((i) => i.sk!.S!.startsWith(VISIT_SK_PREFIX)).every((i) => i.simulated?.BOOL === true)).toBe(true);
    expect(narratives.every((n) => n.simulated === true)).toBe(true);
  });

  it('expires: a demo home anyone can make with one click must not fill the table for ever', () => {
    const expiry = Math.floor((NOW + DEMO_HISTORY_TTL_MS) / 1000);

    expect(DEMO_HISTORY_TTL_MS).toBeGreaterThanOrEqual(60 * DAY);
    expect(items.every((i) => i.ttl?.N === String(expiry))).toBe(true);
  });

  it('has each whole week already written, and already read by the resident (INV-7)', () => {
    expect(narratives.map((n) => n.isoWeek)).toEqual(['2026-W35', '2026-W36', '2026-W37', '2026-W38', '2026-W39', '2026-W40', '2026-W41']);
    for (const week of narratives) {
      const sundayEvening = isoWeekRange(week.isoWeek).endMs - 4 * 3_600_000;
      expect(week.householdId).toBe(HH);
      expect(week.generatedAt).toBe(sundayEvening);
      expect(week.residentSeenAt).toBeGreaterThan(sundayEvening);
      expect(week.residentSeenAt).toBeLessThan(isoWeekRange(week.isoWeek).endMs);
      expect(week.text.length).toBeLessThanOrEqual(MAX_NARRATIVE_CHARS);
      expect(week.textSource).toBe('facts');
    }
    // This week is not written: the Narrator writes it on Sunday, as for any home.
    expect(narratives.some((n) => n.isoWeek === currentIsoWeek(new Date(NOW)))).toBe(false);
  });

  it('makes last week an ordinary one: Maria came twice, and nothing was unusual', () => {
    const lastWeek = narratives.at(-1)!;

    expect(lastWeek.text).toMatch(/Maria/);
    expect(lastWeek.text).toMatch(/Nothing unusual/);
    expect(lastWeek.deltas.every((d) => d.verdict === 'usual')).toBe(true);
    expect(lastWeek.deltas.find((d) => d.metric === 'visit:maria')).toMatchObject({ thisWeek: 2, lastWeek: 2, baselineWeeks: 5 });
  });

  it('leaves the Narrator six observed weeks to measure this week against', () => {
    const thisWeek = factsWeekNarrative(HH, '2026-W42', events, { now: NOW, timeZone: 'Europe/London', observedSince: Math.min(...events.map(at)) });

    expect(thisWeek.deltas[0]).toMatchObject({ metric: 'door', baselineWeeks: 6 });
    expect(thisWeek.deltas.every((d) => d.verdict === 'usual')).toBe(true);
  });

  it('is the same history for the same moment — nothing in it is random', () => {
    expect(demoHomeItems(HH, NOW, 'Europe/London')).toEqual(items);
  });

  it('starts the history on a Monday whatever day the guest arrives', () => {
    for (const day of [0, 1, 2, 3, 4, 5, 6]) {
      const now = W42.startMs + day * DAY + 30 * 60_000;
      const first = Math.min(...demoHomeItems(HH, now, 'Europe/London').filter((i) => i.sk!.S!.startsWith('EVT#')).map(at));
      expect(new Date(first).getUTCDay()).toBe(1);
      expect(first).toBeGreaterThanOrEqual(W42.startMs - FIRST_WEEK * WEEK);
    }
  });
});

describe('the demo home — one thing in it is different', () => {
  /** What Something's Different finds in a demo home made at `now`, read at `readAt`. */
  const different = (now: number, readAt: number = now) => {
    const made = demoHomeItems(HH, now, 'Europe/London');
    const entries = made.flatMap((i) => toTimelineEntry(i) ?? []);
    const roster = made.filter((i) => i.sk!.S!.startsWith('PER#')).map((i) => JSON.parse(i.data!.S!) as RosterEntry);
    const observedSince = Math.min(...entries.map((e) => e.at));
    return whatsDifferent({ entries, roster, now: readAt, observedSince, timeZone: 'Europe/London' });
  };

  it('is that Maria did not come on her most recent morning — and nothing else', () => {
    // Made on the Wednesday afternoon: Tuesday was her morning.
    expect(different(NOW).differences.map((d) => d.sentence)).toEqual([
      'Maria usually comes on Tuesday mornings. There was no visit yesterday.',
    ]);
  });

  it('is her Friday, in a home made after it — and her Tuesday that week is back to usual', () => {
    const saturday = W42.startMs + 5 * DAY + 10 * 3_600_000;
    const made = demoHomeItems(HH, saturday, 'Europe/London');
    const mariaThisWeek = made.filter((i) => i.type?.S === 'presence' && at(i) >= W42.startMs).map((i) => new Date(at(i)).getUTCDay());

    expect(mariaThisWeek).toEqual([2]);
    expect(different(saturday).differences.map((d) => d.sentence)).toEqual([
      'Maria usually comes on Friday mornings. There was no visit yesterday.',
    ]);
  });

  it('is last Friday early in the week, before her first morning is over — a guest never arrives to a home with nothing to be asked', () => {
    const mondayMorning = W42.startMs + 30 * 60_000;
    const tuesdayAtTen = W42.startMs + DAY + 10 * 3_600_000;

    for (const made of [mondayMorning, tuesdayAtTen]) {
      expect(different(made).differences.map((d) => d.lasting)).toEqual([
        'Maria usually comes on Friday mornings. There was no visit on Friday.',
      ]);
    }
  });

  it('has her not come since the morning she missed: a visit after it would make "she did not come" untrue', () => {
    const mariaSince = (now: number, since: number) =>
      demoHomeItems(HH, now, 'Europe/London').filter((i) => i.type?.S === 'presence' && at(i) >= since);

    // Tuesday at ten: her time has passed but she may still be on her way, so Tuesday is not "missed" — and is not recorded either.
    const tuesdayAtTen = W42.startMs + DAY + 10 * 3_600_000;
    expect(mariaSince(tuesdayAtTen, W42.startMs - 3 * DAY)).toEqual([]);

    // Friday at ten: Tuesday is the morning she missed, and this Friday has not happened.
    const fridayAtTen = W42.startMs + 4 * DAY + 10 * 3_600_000;
    expect(mariaSince(fridayAtTen, W42.startMs)).toEqual([]);
    expect(different(fridayAtTen).differences.map((d) => d.lasting)).toEqual([
      'Maria usually comes on Tuesday mornings. There was no visit on Tuesday.',
    ]);
  });

  it('is exactly one thing — her missed visit — whatever hour of whatever day the guest arrives', () => {
    for (let hour = 0; hour < 7 * 24; hour += 1) {
      const made = W42.startMs + hour * 3_600_000 + 5 * 60_000;
      const found = different(made).differences.map((d) => d.kind);

      expect(found, `made ${new Date(made).toISOString()}`).toEqual(['missed_visit']);
    }
  });

  it('never touches the weeks already written when the morning she missed is in this week: last week still has both her visits', () => {
    const lastWeek = events.filter((i) => i.type?.S === 'presence' && at(i) >= W42.startMs - WEEK && at(i) < W42.startMs);

    expect(lastWeek).toHaveLength(2);
  });

  it('writes last week as it then was when the morning she missed is last Friday: one visit, and the story says so', () => {
    const made = demoHomeItems(HH, W42.startMs + 30 * 60_000, 'Europe/London');
    const lastWeekVisits = made.filter((i) => i.type?.S === 'presence' && at(i) >= W42.startMs - WEEK && at(i) < W42.startMs);
    const lastWeekStory = made
      .filter((i) => i.sk!.S!.startsWith('NARR#'))
      .map((i) => JSON.parse(i.data!.S!) as WeekNarrative)
      .find((n) => n.isoWeek === '2026-W41')!;

    expect(lastWeekVisits.map((i) => new Date(at(i)).getUTCDay())).toEqual([2]);
    // Counted from the same rows by the Narrator's own code, so the story cannot disagree with the timeline.
    expect(lastWeekStory.deltas.find((d) => d.metric === 'visit:maria')).toMatchObject({ thisWeek: 1 });
    expect(lastWeekStory.simulated).toBe(true);
  });
});

describe('the demo home — the visits Maria made, already confirmed (The visit, witnessed)', () => {
  const MIN = 60_000;
  /** The visit rows of a demo home made at `now`, as the family's get_visits reads them. */
  const visitsOf = (made: Item[]): Visit[] => made.filter((i) => i.sk!.S!.startsWith(VISIT_SK_PREFIX)).flatMap((i) => visitFromItem(i) ?? []);
  const mariaCame = (made: Item[], since: number): number[] => made.filter((i) => i.type?.S === 'presence' && at(i) >= since).map(at);
  const visits = visitsOf(items);

  it('has a visit on record for each time Maria came in the last fortnight, and for nothing else', () => {
    expect(DEMO_VISIT_RECORD_DAYS).toBe(14);
    // Made on Wednesday the 14th: Friday the 9th, Tuesday the 6th and Friday the 2nd. Tuesday the 13th is the morning she missed.
    expect(visits.map((v) => new Date(v.arrivedAt).toISOString().slice(0, 10))).toEqual(['2026-10-02', '2026-10-06', '2026-10-09']);
    expect(visits.map((v) => v.arrivedAt)).toEqual(mariaCame(items, NOW - DEMO_VISIT_RECORD_DAYS * DAY));
    for (const visit of visits) expect(visit).toMatchObject({ householdId: HH, personId: 'maria', name: 'Maria' });
  });

  it('marks each one simulated: nobody made these visits', () => {
    expect(visits.length).toBeGreaterThan(0);
    expect(visits.every((v) => v.simulated === true)).toBe(true);
  });

  it('has her leave between forty-five and fifty-five minutes after she came — and not after the same time every visit', () => {
    const stayed = visits.map((v) => (v.leftAt! - v.arrivedAt) / MIN);

    for (const minutes of stayed) {
      expect(Number.isInteger(minutes)).toBe(true);
      expect(minutes).toBeGreaterThanOrEqual(45);
      expect(minutes).toBeLessThanOrEqual(55);
    }
    expect(new Set(stayed).size).toBeGreaterThan(1);
  });

  it('has each one asked about once the leaving had stood, and confirmed by the resident', () => {
    for (const visit of visits) {
      expect(visit.answer).toBe('confirmed');
      expect(visit.askedAt!).toBeGreaterThanOrEqual(visit.leftAt! + VISIT_SETTLED_MS);
      expect(visit.answeredAt!).toBeGreaterThan(visit.askedAt!);
      expect(visit.answeredAt!).toBeLessThanOrEqual(NOW);
    }
  });

  it('leaves no question open, whatever hour of whatever day the guest arrives — her latest visit is always too long ago to ask about', () => {
    for (let hour = 0; hour < 7 * 24; hour += 1) {
      const made = W42.startMs + hour * 3_600_000 + 5 * 60_000;
      const home = demoHomeItems(HH, made, 'Europe/London');
      const seeded = visitsOf(home);
      const label = `made ${new Date(made).toISOString()}`;

      // The morning she missed, and any since, are left out of the history: so the latest visit there is to
      // seed is at least three days old, and a visit is only asked about within a day of it (visit.ts readyToAsk).
      const latest = Math.max(...mariaCame(home, 0));
      expect(made - latest, label).toBeGreaterThan(VISIT_ASK_WITHIN_MS);

      expect(seeded.length, label).toBeGreaterThan(0);
      expect(seeded.map((v) => v.arrivedAt), label).toEqual(mariaCame(home, made - DEMO_VISIT_RECORD_DAYS * DAY));
      expect(seeded.every((v) => v.simulated === true && v.answer === 'confirmed' && v.answeredAt! <= made), label).toBe(true);
      expect(seeded.some((v) => readyToAsk(v, made)), label).toBe(false);
    }
  });
});

describe('seedDemoHome', () => {
  it('writes every row, and survives one that fails', async () => {
    const written: Item[] = [];
    let calls = 0;

    await seedDemoHome(async (item) => {
      calls += 1;
      if (calls === 3) throw new Error('throttled');
      written.push(item);
    }, HH, NOW, 'Europe/London');

    expect(calls).toBe(items.length);
    expect(written).toHaveLength(items.length - 1);
  });
});
