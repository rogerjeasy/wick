/**
 * The inverse of timeline.ts's currentIsoWeek: "2026-W38" -> the millisecond
 * range to query. Same ISO 8601 definition — week 1 is the week containing
 * the year's first Thursday, weeks run Monday to Sunday — computed the
 * direct way (Monday of week 1, plus (week-1) weeks) rather than by
 * searching, so it round-trips exactly with currentIsoWeek() at every
 * boundary, including the year-end weeks that roll into the neighbouring
 * December or January.
 */
export interface WeekRange {
  /** Monday 00:00:00.000 UTC. */
  readonly startMs: number;
  /** The following Monday 00:00:00.000 UTC — exclusive. */
  readonly endMs: number;
}

const MS_PER_DAY = 86_400_000;

export function isoWeekRange(isoWeek: string): WeekRange {
  const m = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!m) throw new Error(`not an ISO week, e.g. "2026-W38": "${isoWeek}"`);

  const year = Number(m[1]);
  const week = Number(m[2]);

  const jan4 = Date.UTC(year, 0, 4);
  const jan4DayNum = (new Date(jan4).getUTCDay() + 6) % 7; // 0 = Monday .. 6 = Sunday
  const week1Monday = jan4 - jan4DayNum * MS_PER_DAY;

  const startMs = week1Monday + (week - 1) * 7 * MS_PER_DAY;
  return { startMs, endMs: startMs + 7 * MS_PER_DAY };
}
