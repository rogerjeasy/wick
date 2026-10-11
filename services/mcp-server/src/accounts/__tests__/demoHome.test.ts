import { describe, expect, it } from 'vitest';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { MAX_NARRATIVE_CHARS, currentIsoWeek, parseTimestampFromSortKey, type RosterEntry, type WeekNarrative } from '@wick/contracts';
import { factsWeekNarrative, isoWeekRange, toTimelineEntry, whatsDifferent } from '@wick/agent';
import { DEMO_HISTORY_TTL_MS, DEMO_HISTORY_WEEKS, DEMO_VISITOR, demoHomeItems, seedDemoHome } from '../demoHome.js';

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

  it('is nothing at all early in the week, before her first morning is over', () => {
    const tuesdayAtTen = W42.startMs + DAY + 10 * 3_600_000;

    expect(different(tuesdayAtTen)).toMatchObject({ enoughHistory: true, differences: [] });
  });

  it('never touches the weeks already written: last week still has both her visits', () => {
    const lastWeek = events.filter((i) => i.type?.S === 'presence' && at(i) >= W42.startMs - WEEK && at(i) < W42.startMs);

    expect(lastWeek).toHaveLength(2);
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
