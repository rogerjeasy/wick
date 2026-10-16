/**
 * A visit errand: "The plumber is coming Thursday at ten — let Mum know."
 *
 * A family member asks the assistant (an agent on AgentCore) to arrange it.
 * The member says yes to the plan; from then on code carries it out, over
 * days, as a Step Functions execution: the door is told whom to expect (a
 * roster entry, so the door card can say "This looks like the plumber"),
 * she is reminded on the morning at a natural break, and the member is told
 * when the door rang or when nobody came (docs/WICK-TECHNICAL.md §19).
 *
 * The words "the plumber" are the member's and reach the family again, so
 * they pass the Guardian when the errand is made. What the member is told
 * afterwards is what the door saw — "someone rang around when the plumber
 * was expected" — never that the plumber came.
 *
 * Platform-neutral: the television imports this package too.
 */

export const ERRAND_SK_PREFIX = 'ERRAND#';

export const ERRAND_STATUSES = ['planned', 'reminded', 'waiting', 'rang', 'no_show', 'cancelled', 'failed'] as const;
export type ErrandStatus = (typeof ERRAND_STATUSES)[number];

export const REMINDER_CHOICES = ['morning_of', 'hour_before', 'none'] as const;
export type ReminderChoice = (typeof REMINDER_CHOICES)[number];

export const ERRAND_LIMITS = {
  /** Open errands one household may have at once. */
  maxOpenPerHousehold: 10,
  /** "the plumber", "the window cleaner", "Dave from the council". */
  whoMaxChars: 40,
  /** A ring this many minutes either side of the time still counts (expect_visit's window). */
  windowMinutes: 60,
  /** Soon enough for a judge to watch one run end to end. */
  minLeadMs: 2 * 60_000,
  /** Beyond this a visit is a hope, not a plan (expect_visit's limit). */
  maxLeadMs: 60 * 24 * 3_600_000,
} as const;

/** Where her morning reminder lands on the day, local time. */
export const MORNING_REMINDER_HOUR = 8;

export interface Errand {
  readonly errandId: string;
  readonly householdId: string;
  /** The member who arranged it: from their token, never the request. */
  readonly createdBy: string;
  /** Their name as the resident allowed it (the membership). */
  readonly createdByName: string;
  /** Who is coming, in the member's words, Guardian-cleared. */
  readonly who: string;
  /** The expected moment, epoch ms. */
  readonly at: number;
  readonly windowMinutes: number;
  /** When she is reminded; absent when the member chose no reminder. */
  readonly remindAt?: number;
  /** Whether the member wants to be told how it went. */
  readonly tellMe: boolean;
  readonly status: ErrandStatus;
  /** When the door rang inside the window. */
  readonly rangAt?: number;
  readonly executionArn?: string;
  readonly createdAt: number;
}

const ERRAND_ID = /^err_[A-Za-z0-9_-]{20}$/;
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** A fresh id: "err_" and twenty url-safe characters from the platform's random source. */
export function newErrandId(): string {
  const bytes = new Uint8Array(20);
  globalThis.crypto.getRandomValues(bytes);
  let id = 'err_';
  for (const byte of bytes) id += ID_ALPHABET[byte & 63];
  return id;
}

export const isErrandId = (value: unknown): value is string => typeof value === 'string' && ERRAND_ID.test(value);

export const errandSk = (errandId: string): string => `${ERRAND_SK_PREFIX}${errandId}`;

/** The roster's person id for the visitor an errand expects (the row is `PER#errand:<id>`). */
export const errandPersonId = (errandId: string): string => `errand:${errandId}`;

/** The errand a roster person id belongs to, or undefined for anyone else on the roster. */
export function errandIdOf(personId: unknown): string | undefined {
  if (typeof personId !== 'string' || !personId.startsWith('errand:')) return undefined;
  const id = personId.slice('errand:'.length);
  return isErrandId(id) ? id : undefined;
}

/** Still being carried out: something may yet happen. */
export const isErrandOpen = (status: ErrandStatus): boolean => status === 'planned' || status === 'reminded' || status === 'waiting';

export const isReminderChoice = (value: unknown): value is ReminderChoice =>
  typeof value === 'string' && (REMINDER_CHOICES as readonly string[]).includes(value);

/** The wall clock in `timeZone` at instant `t`, read as if it were UTC: the zone's offset is the difference. */
function wallAsUtc(t: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(t));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

/** The instant the clock in `timeZone` shows `hour`:00 on the local day of `t`. */
function localHourOnDay(t: number, hour: number, timeZone: string): number {
  const wall = new Date(wallAsUtc(t, timeZone));
  const target = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), hour, 0);
  // Twice: the offset at the guess may differ from the offset at the answer across a clock change.
  let guess = target - (wallAsUtc(target, timeZone) - target);
  guess = target - (wallAsUtc(guess, timeZone) - guess);
  return guess;
}

/**
 * When she is reminded of a visit at `at`. Eight in the morning on the day,
 * her time — or an hour before, if the visit is before eight. A reminder
 * whose moment has passed is sent now, as long as the visit is still ahead;
 * a visit that is not ahead gets none.
 */
export function remindAtFor(choice: ReminderChoice, at: number, timeZone: string, now: number): number | undefined {
  if (choice === 'none' || at <= now) return undefined;
  let remindAt = at - 3_600_000;
  if (choice === 'morning_of') {
    const morning = localHourOnDay(at, MORNING_REMINDER_HOUR, timeZone);
    if (morning < at) remindAt = morning;
  }
  return Math.max(remindAt, now);
}

export const ERRAND_EVENTS = {
  /** The door Lambda's events on the Wick bus. */
  source: 'wick.door',
  /** Every ring, real or stand-in, after the door card is made. */
  doorRang: 'door.rang',
} as const;

export interface DoorRangDetail {
  readonly householdId: string;
  readonly at: number;
  readonly cardId: string;
  /** Who the door card said it looks like, if anyone (a roster person id). */
  readonly matchPersonId?: string;
}

/** A `door.rang` detail, or undefined if it is not one. Events on the bus are read, not trusted. */
export function readDoorRangDetail(raw: unknown): DoorRangDetail | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const d = raw as Record<string, unknown>;
  if (typeof d.householdId !== 'string' || !d.householdId) return undefined;
  if (typeof d.at !== 'number' || !Number.isFinite(d.at)) return undefined;
  if (typeof d.cardId !== 'string' || !d.cardId) return undefined;
  if (d.matchPersonId !== undefined && typeof d.matchPersonId !== 'string') return undefined;
  return {
    householdId: d.householdId,
    at: d.at,
    cardId: d.cardId,
    ...(typeof d.matchPersonId === 'string' ? { matchPersonId: d.matchPersonId } : {}),
  };
}
