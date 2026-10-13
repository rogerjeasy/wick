/**
 * The visit, witnessed — her OK turns the carer's visit into a record.
 *
 * A regular visitor rings at 9:02 and the Door agent matches them to the
 * roster, as it always has. The door next sees somebody at 9:47: they have
 * left. Once that has stood for a little while, and the resident is at the
 * television, she is asked at the next natural break:
 *
 *   "Is this right? Maria was here on Tuesday from 9:02 am to 9:47 am."
 *
 * "Yes, that's right" makes it a visit the resident herself confirmed.
 * "No, that's not right" confirms nothing — and whether the family hears
 * that she disputed it is hers to decide, through "Shall I tell Sarah?"
 * like any other difference (tell.ts, INV-10).
 *
 * Wick proposes and she attests. The times are the door's best reading,
 * not a fact: the first sighting is the arrival and the last sighting
 * before she is asked is the leaving, and a wrong reading is what "No" is
 * for. Nothing is watched inside the house, and no camera decides anything.
 *
 * One row per visit: `HH#<household>` / `VISIT#<arrivedAt>#<personId>`,
 * opened by the Door agent (services/agent agents/visit) and read by the
 * family's get_visits tool. To the family a visit is confirmed or it is
 * not: one she has not been asked about yet, one still waiting for her
 * answer and one she disputed are the same word, so that disputing a visit
 * does not itself tell anyone.
 */
import type { QueuedCard } from './card.js';
import { padTimestamp } from './timeline.js';

export const VISIT_SK_PREFIX = 'VISIT#';

/** The Visit card's actions. One press answers; either finishes the card. */
export const VISIT_ACTIONS = {
  right: 'visit_right',
  wrong: 'visit_wrong',
} as const;

export type VisitAnswer = 'confirmed' | 'disputed';

export function visitAnswerOf(action: unknown): VisitAnswer | undefined {
  if (action === VISIT_ACTIONS.right) return 'confirmed';
  if (action === VISIT_ACTIONS.wrong) return 'disputed';
  return undefined;
}

/** Less than this at the door is still arriving: the visitor on the step, the door closing behind them. */
export const VISIT_MIN_MS = 5 * 60_000;
/** A sighting later than this is somebody else's: no visit is taken to last longer. */
export const VISIT_WINDOW_MS = 4 * 60 * 60_000;
/** How long the leaving must have stood before she is asked: they may have gone to the car and come back. */
export const VISIT_SETTLED_MS = 10 * 60_000;
/** After this a visit is too long ago to ask about; it simply stays unconfirmed. */
export const VISIT_ASK_WITHIN_MS = 24 * 60 * 60_000;

export interface Visit {
  readonly householdId: string;
  /** The roster's id for the visitor. */
  readonly personId: string;
  readonly name: string;
  readonly arrivedAt: number;
  /** The last time the door saw somebody before she was asked. Absent when nobody was seen leaving. */
  readonly leftAt?: number;
  readonly askedAt?: number;
  readonly answer?: VisitAnswer;
  readonly answeredAt?: number;
  /** A demo home's visit: never a real person's (AGENTS.md, the demo home). */
  readonly simulated?: boolean;
}

/** Nothing that could not be part of a key or a card id. */
const PERSON_ID = /^[A-Za-z0-9_-]+$/;
const VISIT_ID = /^(\d{13,16})-([A-Za-z0-9_-]+)$/;
const VISIT_CARD_PREFIX = 'visit-';

export const isVisitPersonId = (personId: unknown): personId is string => typeof personId === 'string' && PERSON_ID.test(personId);

export function visitId(visit: Pick<Visit, 'arrivedAt' | 'personId'>): string {
  return `${visit.arrivedAt}-${visit.personId}`;
}

export function parseVisitId(id: unknown): { readonly arrivedAt: number; readonly personId: string } | undefined {
  const match = typeof id === 'string' ? VISIT_ID.exec(id) : null;
  return match ? { arrivedAt: Number(match[1]), personId: match[2]! } : undefined;
}

/** Sorted by when they came, so a stretch of days is one range. */
export function visitSk(visit: Pick<Visit, 'arrivedAt' | 'personId'>): string {
  return `${VISIT_SK_PREFIX}${padTimestamp(visit.arrivedAt)}#${visit.personId}`;
}

export function visitCardId(id: string): string {
  return `${VISIT_CARD_PREFIX}${id}`;
}

/** The visit a Visit card asks about, or undefined for any other card. */
export function visitIdFromCardId(cardId: unknown): string | undefined {
  if (typeof cardId !== 'string' || !cardId.startsWith(VISIT_CARD_PREFIX)) return undefined;
  const id = cardId.slice(VISIT_CARD_PREFIX.length);
  return parseVisitId(id) ? id : undefined;
}

/**
 * Whether somebody seen at the door at `at` is this visitor leaving: they
 * have been in long enough to have visited, it is within the longest a
 * visit is taken to last, it is later than any leaving already noted, and
 * she has not been asked yet — once she has, the times are hers to judge.
 */
export function departureOf(visit: Visit, at: number): boolean {
  if (visit.askedAt !== undefined) return false;
  const stayed = at - visit.arrivedAt;
  if (stayed < VISIT_MIN_MS || stayed > VISIT_WINDOW_MS) return false;
  return visit.leftAt === undefined || at > visit.leftAt;
}

/** Whether it is time to ask her about this visit. Once, soon after, and never long after. */
export function readyToAsk(visit: Visit, now: number): boolean {
  if (visit.askedAt !== undefined || now - visit.arrivedAt >= VISIT_ASK_WITHIN_MS) return false;
  return visit.leftAt !== undefined ? now - visit.leftAt >= VISIT_SETTLED_MS : now - visit.arrivedAt >= VISIT_WINDOW_MS;
}

const weekday = (at: number, timeZone: string): string => new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(at);

/** "9:02 am", where the house is. */
export function clockTime(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(at);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('hour')}:${part('minute')} ${part('dayPeriod').toLowerCase().replace(/\./g, '').replace(/\s/g, '')}`;
}

const when = (visit: Visit, timeZone: string): string =>
  visit.leftAt === undefined
    ? `on ${weekday(visit.arrivedAt, timeZone)} at ${clockTime(visit.arrivedAt, timeZone)}`
    : `on ${weekday(visit.arrivedAt, timeZone)} from ${clockTime(visit.arrivedAt, timeZone)} to ${clockTime(visit.leftAt, timeZone)}`;

/** What was noted, in one sentence that is still true when read on another day: the day by name, never "today". */
export function visitSentence(visit: Visit, timeZone: string): string {
  return visit.leftAt === undefined ? `${visit.name} came ${when(visit, timeZone)}.` : `${visit.name} was here ${when(visit, timeZone)}.`;
}

/** What the family is told if she says it is not right and chooses to tell them — the very sentence she is shown (tell.ts). */
export function disputedSentence(visit: Visit, timeZone: string): string {
  return `Wick noted that ${visit.name} ${visit.leftAt === undefined ? 'came' : 'was here'} ${when(visit, timeZone)}. That is not right.`;
}

/** The card. Deferred like a note (INV-5): it waits for a natural break, and nothing about it is urgent. */
export function buildVisitCard(visit: Visit, timeZone: string, now: number): QueuedCard {
  const id = visitCardId(visitId(visit));
  return {
    id,
    urgency: 'DEFERRED',
    queuedAt: now,
    shownCount: 0,
    card: {
      type: 'VISIT',
      id,
      householdId: visit.householdId,
      correlationId: id,
      createdAt: now,
      headline: 'Is this right?',
      detail: visitSentence(visit, timeZone),
      actions: [
        { id: VISIT_ACTIONS.right, label: 'Yes, that’s right', kind: 'primary' },
        { id: VISIT_ACTIONS.wrong, label: 'No, that’s not right', kind: 'secondary' },
      ],
    },
  };
}
