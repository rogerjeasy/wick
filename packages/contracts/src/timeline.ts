/**
 * Shared EVT# timeline wire-format helpers.
 *
 * The 15-digit zero-padded millisecond encoding here is a wire contract with
 * services/edge-device/lambda/route.mjs, the real production writer of EVT#
 * rows (`EVT#<15-digit-zero-padded-ms>#<uuid>`). route.mjs is a plain .mjs
 * Lambda and can't import this module, so it inlines the same encoding with a
 * pointer comment back to this file — this file is the single TypeScript
 * source of truth for the encoding. Previously `padTs`/`parseTsFromSk` were
 * copy-pasted identically across get_today.ts, did_visitor_come.ts and
 * scripts/seed-mcp-stub-data.ts; `currentIsoWeek` across get_week_narrative.ts
 * and the seed script. Consolidated here so there is exactly one definition
 * for each.
 */

/** Zero-padded to 15 digits, matching route.mjs's EVT# sort key exactly. */
export function padTimestamp(ms: number): string {
  return String(ms).padStart(15, '0');
}

/** Parses the ms timestamp embedded in an `EVT#<15-digit>#<uuid>` sort key. */
export function parseTimestampFromSortKey(sk: string): number {
  const match = /^EVT#(\d{15})#/.exec(sk);
  return match ? Number(match[1]) : 0;
}

/** ISO 8601 week, e.g. "2026-W38". */
export function currentIsoWeek(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** What one moment at the door can be written as, from the plainest to the most it says. */
const SAYS_MORE: Readonly<Record<string, number>> = { door: 1, presence: 2, visit: 3 };

/**
 * One line for one moment at the door, for whoever reads the list. A ring
 * when Maria was expected writes a `door` row and a `presence` row, and a
 * visit she confirmed a VISIT# row — three lines at 9:00 for one visit (seen
 * 2026-10-20: "Three things" on a Tuesday, "Nine things" for five rings).
 * Within one minute only the line that says the most is kept: a confirmed
 * visit over "came when expected", and either over "someone was at the
 * door". Counts are not taken from this: the week's own facts count the door
 * and the visits apart, as they always did.
 *
 * Any other kind of entry is kept as it is. The order is kept.
 */
export function oneLinePerMoment<Entry extends { readonly at: number; readonly kind: string }>(entries: readonly Entry[]): Entry[] {
  const minuteOf = (at: number): number => Math.floor(at / 60_000);
  const most = new Map<number, number>();
  for (const entry of entries) {
    const rank = SAYS_MORE[entry.kind];
    if (rank !== undefined) most.set(minuteOf(entry.at), Math.max(most.get(minuteOf(entry.at)) ?? 0, rank));
  }
  return entries.filter((entry) => {
    const rank = SAYS_MORE[entry.kind];
    return rank === undefined || rank === most.get(minuteOf(entry.at));
  });
}
