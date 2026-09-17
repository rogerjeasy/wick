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
