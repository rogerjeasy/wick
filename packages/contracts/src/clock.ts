/**
 * The day and the time where the house is.
 *
 * A regular visitor's "TUE,FRI 09:00±30m" is said on the household's own
 * clock, and stays on it: nine o'clock is nine o'clock in summer and in
 * winter. Everything that compares a moment with such a pattern reads the
 * moment here, never in UTC (issue #84).
 */
export const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
export type DayCode = (typeof DAY_CODES)[number];

function parts(at: number, timeZone: string): { readonly weekday: string; readonly hour: number; readonly minute: number } {
  const found = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => found.find((p) => p.type === type)?.value ?? '';
  return { weekday: part('weekday').toUpperCase(), hour: Number(part('hour')), minute: Number(part('minute')) };
}

/** "TUE" for a moment that is a Tuesday where the house is. */
export function localDayCode(at: number, timeZone: string): DayCode {
  const day = parts(at, timeZone).weekday as DayCode;
  return DAY_CODES.includes(day) ? day : DAY_CODES[new Date(at).getUTCDay()]!;
}

/** Minutes since midnight where the house is: 09:59 is 599. */
export function localMinuteOfDay(at: number, timeZone: string): number {
  const { hour, minute } = parts(at, timeZone);
  return (hour % 24) * 60 + minute;
}
