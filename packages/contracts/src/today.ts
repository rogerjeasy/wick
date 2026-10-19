/**
 * Her day, on her home screen.
 *
 * The home screen used to open on a question about films. It now opens on
 * her: "Good morning, Margaret.", the date, and who is coming — "Maria
 * usually comes tomorrow at 9 am.", "The window cleaner is expected today
 * at 10:18 am. Sarah arranged it." The films are still there, under it.
 *
 * Everything in it is already Wick's to know and hers to see: the roster the
 * door matches against (regular visitors, a visit a member said they would
 * make, a visit a member arranged — door.ts RosterEntry), her name as the
 * household was made with it, and the date where the house is. Nothing new
 * is measured, nothing is guessed, and nothing in it goes to the family: it
 * rides on the home message, which only her own televisions are sent
 * (light.ts HomeState; AGENTS.md INV-1).
 *
 * The edge writes it (services/edge-device/lambda/today.mjs) on the
 * household's clock, so a television whose own clock is set elsewhere — the
 * Vega Virtual Device's runs in UTC — still says "today" on the right day.
 * The television only decides what is still worth saying now: a line whose
 * time has passed goes, and a day that has ended is asked for afresh
 * (`dayToShow`, and `{ t: 'home' }` in device.ts).
 *
 * The rules it keeps (docs/WICK.md §7):
 *   - Three things, never four (`MAX_COMING`).
 *   - When unsure, say so: a regular visitor "usually comes", an arranged
 *     visit "is expected". Nothing here says anyone came.
 *   - No countdown, no red, nothing that moves: a line is simply not there
 *     once its time is over.
 */

/** At most this many lines about who is coming: the rest wait for their day. */
export const MAX_COMING = 3;

/** One line about who is coming, and until when it is worth saying. */
export interface Coming {
  /** A whole sentence, in English as the edge writes it and in her language as it reaches her (phrasebook). */
  readonly line: string;
  /** After this moment the line is no longer true to say: the visit's time is over, or "tomorrow" has become today. */
  readonly until: number;
}

/** Her day, as the home screen is told it (HomeState.today). */
export interface HerDay {
  /** The weekday where the house is: 0 is Monday. */
  readonly weekday: number;
  /** The day of the month, 1 to 31. */
  readonly day: number;
  /** The month, from 0 (January). */
  readonly month: number;
  /** Her first name as the household knows her, for the greeting. Absent when there is none to use. */
  readonly name?: string;
  /** The first moment of that day where the house is: what "morning" is counted from. */
  readonly dayStart: number;
  /** The first moment of the next day: when all of this is yesterday's, and is asked for again. */
  readonly dayEnd: number;
  /**
   * When the server wrote this, by its clock. A television whose own clock is
   * wrong — the Android TV emulator's ran eight hours out, and greeted her
   * "Good morning" in the evening — puts the whole day onto its own clock
   * with it as the message arrives (`onThisClock`).
   */
  readonly told?: number;
  /** In the order they happen; at most MAX_COMING. */
  readonly coming: readonly Coming[];
}

/** The part of the day her greeting names. */
export type PartOfDay = 'morning' | 'afternoon' | 'evening';

const HOUR_MS = 3_600_000;

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isWhole = (value: unknown, from: number, to: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= from && value <= to;

/** A first name fit for a greeting: one to forty characters, no line breaks. */
const isName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 40 && !/[\r\n]/.test(value);

/** A line fit for the home screen: a sentence of reasonable length. */
const isLine = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;

/**
 * Her day from something that is not this code — the bus between the edge
 * and the agent plane, or the wire. What is well formed is kept; a line
 * that is not is dropped; undefined when it is not a day at all.
 */
export function readHerDay(value: unknown): HerDay | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { weekday, day, month, name, dayStart, dayEnd, told, coming } = value as Record<string, unknown>;
  if (!isWhole(weekday, 0, 6) || !isWhole(day, 1, 31) || !isWhole(month, 0, 11) || !isTime(dayStart) || !isTime(dayEnd) || dayEnd <= dayStart) return undefined;
  const lines = Array.isArray(coming) ? coming : [];
  const kept = lines
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .filter((item) => isLine(item.line) && isTime(item.until))
    .map((item) => ({ line: item.line as string, until: item.until as number }))
    .slice(0, MAX_COMING);
  return { weekday, day, month, ...(isName(name) ? { name } : {}), dayStart, dayEnd, ...(isTime(told) ? { told } : {}), coming: kept };
}

/**
 * What her home screen says of her day at this moment: the part of the day
 * for the greeting, and the lines still worth saying. Undefined when the
 * day it was told is over (or not begun — a clock that has gone back): then
 * nothing of it is shown, and the television asks for today's.
 *
 * Counted from the day's own start, so the television's clock is used only
 * for how much time has passed — never for what day it is.
 */
export function dayToShow(today: HerDay | undefined, now: number): { readonly part: PartOfDay; readonly coming: readonly Coming[] } | undefined {
  if (!today || now < today.dayStart || now >= today.dayEnd) return undefined;
  const hours = (now - today.dayStart) / HOUR_MS;
  const part: PartOfDay = hours < 12 ? 'morning' : hours < 18 ? 'afternoon' : 'evening';
  return { part, coming: today.coming.filter((item) => now < item.until) };
}

/** Whether the day it was told is over, so the television should ask for today's. */
export function dayIsOver(today: HerDay | undefined, now: number): boolean {
  return today !== undefined && now >= today.dayEnd;
}

/**
 * Her day on this television's clock: every moment in it moved by however
 * far this clock is from the server's, measured as the message arrives
 * (`receivedAt`, this clock; `told`, the server's). From then on the
 * television counts with its own clock and is right — only the gap between
 * the two clocks was wrong. A day with no `told` is left as it is.
 */
export function onThisClock(today: HerDay, receivedAt: number): HerDay;
export function onThisClock(today: HerDay | undefined, receivedAt: number): HerDay | undefined;
export function onThisClock(today: HerDay | undefined, receivedAt: number): HerDay | undefined {
  if (!today || today.told === undefined) return today;
  const skew = receivedAt - today.told;
  return {
    ...today,
    dayStart: today.dayStart + skew,
    dayEnd: today.dayEnd + skew,
    told: receivedAt,
    coming: today.coming.map((c) => ({ ...c, until: c.until + skew })),
  };
}
