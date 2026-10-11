/**
 * Days and times as a household means them.
 *
 * "Saturday at three" is three o'clock where the house is, not in UTC. The
 * door matches a ring against an absolute moment (services/agent/src/
 * agents/door/roster.ts), so a time somebody says has to be turned into
 * one here, once, in the household's own zone.
 */
const DAY_MS = 86_400_000;

/** The wall-clock time `atMs` shows in `timeZone`, read back as if it were UTC. */
function wallClockAsUtc(atMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(atMs));
  const part = (type: string): number => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
}

/** "2026-10-17", "15:00" in the household's zone -> the moment, or undefined if either is not a real date or time. */
export function localToUtc(date: string, time: string, timeZone: string): number | undefined {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return undefined;
  const [year, month, day, hour, minute] = [d[1], d[2], d[3], t[1], t[2]].map(Number) as [number, number, number, number, number];
  if (hour > 23 || minute > 59) return undefined;

  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(asUtc);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;
  // The zone's offset at that moment, applied once: exact except inside the
  // hour a clock change skips or repeats, which no visit is planned by.
  return asUtc - (wallClockAsUtc(asUtc, timeZone) - asUtc);
}

/** The UTC day a "YYYY-MM-DD" names, as its first millisecond — the day the timeline's rows are filed by. */
export function utcDayStart(date: string): number | undefined {
  const at = localToUtc(date, '00:00', 'UTC');
  return at === undefined ? undefined : at - (at % DAY_MS);
}
