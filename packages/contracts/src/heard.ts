/**
 * Heard from the doorbell — what lets Wick tell a quiet day from a day it
 * could not see.
 *
 * Wick learns of the door only from Ring's events. A day with no event is
 * either a day nobody came or a day the doorbell, its Wi-Fi, its link or
 * Ring itself was down, and the two look the same. So every event from a
 * household's doorbell — any motion, any press, whether or not it is worth
 * a card — marks its hour as heard: `HH#<household>` / `HEARD#<yyyy-mm-dd>`
 * (the UTC day), holding the UTC hours heard. Nothing else is kept: not the
 * event, not its kind, not the device.
 *
 * Anything Wick says from an absence — nobody came when a visitor was
 * expected, the door was quieter than usual — is said only when the
 * doorbell was heard both before and after the stretch it is about
 * (`heardAround`). Otherwise Wick says nothing about that stretch: it does
 * not know.
 */

export const HEARD_SK_PREFIX = 'HEARD#';

export const HOUR_MS = 3_600_000;

/** How far either side of a stretch the doorbell must have been heard. */
export const HEARD_REACH_MS = 12 * HOUR_MS;
/** How far inside a stretch a hearing still counts as "before" or "after" it. */
export const HEARD_SLACK_MS = 3 * HOUR_MS;
/** Longer than this without a word from the doorbell, and it is said to be unheard. */
export const NOT_HEARD_AFTER_MS = 6 * HOUR_MS;
/** How long a HEARD# row is kept: the baseline looks back six weeks. */
export const HEARD_KEPT_DAYS = 60;

/** The row a moment is filed under: its UTC day. */
export function heardSk(at: number): string {
  return `${HEARD_SK_PREFIX}${new Date(at).toISOString().slice(0, 10)}`;
}

/** The UTC hour a moment falls in, as kept on the row. */
export function heardHourOf(at: number): number {
  return new Date(at).getUTCHours();
}

/** The start of every hour a row says was heard, in milliseconds. A row that is not one gives none. */
export function heardHoursOf(sk: string | undefined, hours: readonly (string | number)[] | undefined): number[] {
  const day = sk?.startsWith(HEARD_SK_PREFIX) ? Date.parse(`${sk.slice(HEARD_SK_PREFIX.length)}T00:00:00Z`) : Number.NaN;
  if (!Number.isFinite(day) || !hours) return [];
  return hours
    .map(Number)
    .filter((h) => Number.isInteger(h) && h >= 0 && h < 24)
    .map((h) => day + h * HOUR_MS)
    .sort((a, b) => a - b);
}

/**
 * Whether the doorbell was heard on both sides of the stretch `from`–`to`:
 * some hour heard from twelve hours before it to three hours into it, and
 * some hour heard from three hours before its end to twelve hours after (and
 * not after `now`). An hour counts if any part of it falls there.
 */
export function heardAround(heard: readonly number[], from: number, to: number, now: number): boolean {
  const touches = (start: number, end: number): boolean => heard.some((h) => h + HOUR_MS > start && h <= end);
  return touches(from - HEARD_REACH_MS, from + HEARD_SLACK_MS) && touches(to - HEARD_SLACK_MS, Math.min(to + HEARD_REACH_MS, now));
}

/**
 * The whole days from `from` to `to` on which the doorbell was not heard at
 * all — each day given by its start. A day still under way is not judged,
 * and nor is one before `trackedSince`, when Wick was not yet listening.
 * `dayStarts` are the household's local midnights (clock.ts), in order.
 */
export function unheardDayStarts(heard: readonly number[], dayStarts: readonly number[], now: number, trackedSince: number | undefined): number[] {
  if (trackedSince === undefined) return [];
  return dayStarts.flatMap((start, i) => {
    const end = dayStarts[i + 1] ?? start + 24 * HOUR_MS;
    if (end > now || end <= trackedSince) return [];
    return heard.some((h) => h + HOUR_MS > start && h < end) ? [] : [start];
  });
}

/** The end of the last hour the doorbell was heard, up to `now`. Undefined when it was not heard at all. */
export function lastHeard(heard: readonly number[], now: number): number | undefined {
  const last = heard.filter((h) => h <= now).at(-1);
  return last === undefined ? undefined : Math.min(last + HOUR_MS, now);
}

/** Whether the doorbell has gone unheard for longer than NOT_HEARD_AFTER_MS: Wick cannot see the door just now. */
export function doorUnheard(heard: readonly number[], now: number): boolean {
  const last = lastHeard(heard, now);
  return last === undefined || now - last > NOT_HEARD_AFTER_MS;
}
