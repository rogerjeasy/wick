/**
 * The tools' answers, as the Guardrail's grounding check can read them.
 *
 * A tool answers in JSON, its moments in epoch milliseconds and its weeks as
 * ISO weeks ("2026-W41"). The agent reads those well and says "on Tuesday" or
 * "the week of 5 October"; the Guardrail's grounding check, measured live,
 * cannot find either in the JSON and refused such true sentences (scores 0.08
 * to 0.34, against 0.98 for the same reply without the day). So the grounding
 * source writes each moment as the day, date and time at the house, and each
 * ISO week with the Monday it starts on. Nothing else changes, and the agent
 * itself never sees this copy.
 */

/** Epoch milliseconds between 2001 and 2096: a moment, not a count. */
const MIN_MS = 1e12;
const MAX_MS = 4e12;
const ISO_WEEK = /^(\d{4})-W(\d{2})$/;

const isMomentKey = (key: string) => key === 'at' || key.endsWith('At');

/** "Tuesday 6 October 2026", built from its parts: the locale's own punctuation varies by runtime. */
function day(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')} ${part('year')}`;
}

function moment(ms: number, timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  return `${day(ms, timeZone)}, ${time}`;
}

/** The Monday an ISO week starts on: week 1 is the one with 4 January in it. */
function weekOf(isoWeek: string): string | undefined {
  const match = ISO_WEEK.exec(isoWeek);
  if (!match) return undefined;
  const jan4 = Date.UTC(Number(match[1]), 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86_400_000 + (Number(match[2]) - 1) * 7 * 86_400_000;
  return `${isoWeek}, the week of ${day(monday, 'UTC')}`;
}

function readable(value: unknown, timeZone: string, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => readable(item, timeZone));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, readable(v, timeZone, k)]));
  }
  if (typeof value === 'number' && isMomentKey(key) && value >= MIN_MS && value <= MAX_MS) return moment(value, timeZone);
  if (typeof value === 'string' && key === 'isoWeek') return weekOf(value) ?? value;
  return value;
}

export function readableForGrounding(text: string, timeZone: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!parsed || typeof parsed !== 'object') return text;
  return JSON.stringify(readable(parsed, timeZone));
}
