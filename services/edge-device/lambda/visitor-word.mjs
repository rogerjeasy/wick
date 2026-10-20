/**
 * What a visitor said from their visit pass (packages/contracts
 * visitPass.ts), as the edge keeps and reads it: one of three words, when,
 * and how late. Kept as JSON in a `visitorWord` attribute of its own, on the
 * errand's row and beside the door's roster entry (visit-pass.mjs), and read
 * back by her day (today.mjs).
 *
 * This plain .mjs can't import TS; these are inlined from visitPass.ts, and
 * __tests__/visit-pass.test.ts holds them to it.
 *
 * Pure.
 */

/** contracts visitPass.ts VISITOR_SAYS. */
export const VISITOR_SAYS = ['on_way', 'late', 'at_door'];
/** contracts visitPass.ts VISIT_PASS_LIMITS (atDoorFreshMs is the door's, not the edge's). */
export const VISIT_PASS_LIMITS = { opensBeforeMs: 3 * 3_600_000, lateStepMinutes: 15, maxPresses: 30 };

export const isVisitorSays = (value) => typeof value === 'string' && VISITOR_SAYS.includes(value);

/** contracts visitPass.ts readVisitorWord. Rows are read, not trusted. */
export function readVisitorWord(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined;
  if (!isVisitorSays(raw.says) || typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined;
  if (raw.says === 'late') {
    if (typeof raw.lateMinutes !== 'number' || !Number.isFinite(raw.lateMinutes) || raw.lateMinutes <= 0) return undefined;
    return { says: 'late', at: raw.at, lateMinutes: raw.lateMinutes };
  }
  return { says: raw.says, at: raw.at };
}

/** The word kept on a row, or undefined: none, or one that does not read as a word. */
export function visitorWordOfRow(item) {
  const raw = item?.visitorWord?.S;
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    return readVisitorWord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
