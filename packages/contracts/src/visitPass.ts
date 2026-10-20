/**
 * The visit pass: the visitor a family member arranged says, from their own
 * phone, that they are on the way, running late, or at the door.
 *
 * An expected stranger and an unknown stranger look the same at her door:
 * a different doctor each time, nobody she recognises, a door kept shut and
 * a telephone call to a daughter in another country. The door alone can only
 * say who is due, never who has come (door/index.ts, 2026-10-20). A pass is
 * the first thing that can: a link Wick handed the member, forwarded by them
 * to the visitor, pressed at the door around the ring. No model decides it,
 * and no face is kept.
 *
 *   arrange_visit (Wick server)        the visit: who, when, who arranged it
 *   make_visit_pass (Wick server)      a token for that one visit; its hash is kept, the token is shown once
 *   visit.html (family app site)       three buttons and nothing about the house
 *   POST /visit/say (edge visit-pass)  the token's hash finds the visit; what was said is kept on it
 *     -> her day (edge today.mjs)      "Doctor Rossi is on the way. Sarah arranged it."
 *     -> wick.visit / visit.said       the agent plane: the member is nudged; a door card already up is told
 *   the door (agent door/route.ts)     a ring within ten minutes of "I'm at the door" says who is there
 *
 * What the pass can do is what this file lists: say one of three things
 * about one visit, inside that visit's hours. It reads nothing, names
 * nobody, and can never make the door say "you can open": the card states
 * what Wick knows, and opening is hers.
 *
 * Platform-neutral: the television imports this package too. Hashing the
 * token is the server's and the edge's (node:crypto), not this file's.
 */
import type { PushKind } from './push.js';
import { PUSH_KINDS } from './push.js';
import { isErrandId } from './errand.js';

/** What a visitor can say. Three, and only these. */
export const VISITOR_SAYS = ['on_way', 'late', 'at_door'] as const;
export type VisitorSays = (typeof VISITOR_SAYS)[number];

export const isVisitorSays = (value: unknown): value is VisitorSays =>
  typeof value === 'string' && (VISITOR_SAYS as readonly string[]).includes(value);

export const VISIT_PASS_LIMITS = {
  /** A pass opens this long before the visit: time to say "on my way". */
  opensBeforeMs: 3 * 3_600_000,
  /** "Running late" adds this much each time it is pressed. */
  lateStepMinutes: 15,
  /** "I'm at the door" counts for a ring this long either side of it. */
  atDoorFreshMs: 10 * 60_000,
  /** Presses one pass may make, ever: three buttons do not need more. */
  maxPresses: 30,
} as const;

/** `VPASS#<sha-256 of the token, hex>`: a pass is found by its hash and nothing else. Its sort key is the same word. */
export const VISIT_PASS_PK_PREFIX = 'VPASS#';
export const VISIT_PASS_SK = 'VPASS';
export const visitPassPk = (tokenHash: string): string => `${VISIT_PASS_PK_PREFIX}${tokenHash}`;

/**
 * A token: 128 random bits as 32 lower-case hex characters. Hex because the
 * link is handed to the member through a gated tool (INV-2), and a run of
 * hex is one word to the Guardian's lexicon: base64's "-" and "_" could cut
 * "dr" out of a random string.
 */
const TOKEN = /^[0-9a-f]{32}$/;
export const isVisitPassToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value);

/** Where the visitor's page lives on the family app's site; the token goes after `#`, so no server's log ever holds it. */
export const VISIT_PAGE_PATH = '/visit.html';

/** What the pass says about now: not open yet, open, or over (the window has passed, or the visit has ended). */
export type PassState = 'not_yet' | 'open' | 'over';

/** Whether a pass for a visit at `at` with this window works at `now`. */
export function passStateAt(visit: { readonly at: number; readonly windowMinutes: number }, now: number): PassState {
  if (now < visit.at - VISIT_PASS_LIMITS.opensBeforeMs) return 'not_yet';
  if (now > visit.at + visit.windowMinutes * 60_000) return 'over';
  return 'open';
}

/** "Running late" pressed again: another quarter of an hour, never beyond the visit's own window. */
export function nextLateMinutes(current: number | undefined, windowMinutes: number): number {
  return Math.min((current ?? 0) + VISIT_PASS_LIMITS.lateStepMinutes, windowMinutes);
}

/** The last thing the visitor said, as it is kept on the visit (its roster row and its errand row). */
export interface VisitorWord {
  readonly says: VisitorSays;
  /** When it was pressed, epoch ms, by the edge's clock. */
  readonly at: number;
  /** "late" only: how late, in minutes, all told. */
  readonly lateMinutes?: number;
}

/** A kept word, or undefined. Rows are read, not trusted. */
export function readVisitorWord(raw: unknown): VisitorWord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const w = raw as Record<string, unknown>;
  if (!isVisitorSays(w.says) || typeof w.at !== 'number' || !Number.isFinite(w.at)) return undefined;
  if (w.says === 'late') {
    if (typeof w.lateMinutes !== 'number' || !Number.isFinite(w.lateMinutes) || w.lateMinutes <= 0) return undefined;
    return { says: 'late', at: w.at, lateMinutes: w.lateMinutes };
  }
  return { says: w.says, at: w.at };
}

/** "I'm at the door", near enough to a ring at `ringAt` to be about it. */
export function visitorSaidFresh(word: VisitorWord | undefined, ringAt: number): boolean {
  return word?.says === 'at_door' && Math.abs(ringAt - word.at) <= VISIT_PASS_LIMITS.atDoorFreshMs;
}

/** The nudge the member gets for each: a kind, and nothing about the house (push.ts). */
export function pushKindForVisitor(says: VisitorSays): PushKind {
  if (says === 'on_way') return PUSH_KINDS.visitorOnWay;
  if (says === 'late') return PUSH_KINDS.visitorLate;
  return PUSH_KINDS.visitorAtDoor;
}

/** The edge's event when a visitor pressed a button (edge-device visit-pass.mjs). */
export const VISIT_EVENTS = { source: 'wick.visit', said: 'visit.said' } as const;

export interface VisitSaidDetail {
  readonly householdId: string;
  readonly errandId: string;
  readonly says: VisitorSays;
  readonly at: number;
}

/** A `visit.said` detail, or undefined. Events on the bus are read, not trusted. */
export function readVisitSaidDetail(raw: unknown): VisitSaidDetail | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const d = raw as Record<string, unknown>;
  if (typeof d.householdId !== 'string' || !d.householdId) return undefined;
  if (!isErrandId(d.errandId) || !isVisitorSays(d.says)) return undefined;
  if (typeof d.at !== 'number' || !Number.isFinite(d.at)) return undefined;
  return { householdId: d.householdId, errandId: d.errandId, says: d.says, at: d.at };
}

/** "the doctor" -> "The doctor": the first word of a sentence. The member's own words are otherwise kept as typed. */
const opening = (words: string): string => {
  const trimmed = words.trim();
  return trimmed ? trimmed[0]!.toLocaleUpperCase('en-GB') + trimmed.slice(1) : trimmed;
};
const firstNameOf = (name: string | undefined): string => name?.trim().split(/\s+/)[0] ?? '';

/** The door card's headline when the visitor said they were at the door around the ring. */
export const visitorArrivedLine = (who: string): string => `${opening(who)} is at your door.`;

/** Under it: how Wick knows, and who arranged it. Never "you can open". */
export const visitorConfirmedNotice = (arrangedByName: string): string => {
  const first = firstNameOf(arrangedByName);
  return first ? `They confirmed it on their phone just now. ${first} arranged this visit.` : 'They confirmed it on their phone just now.';
};

/**
 * A ring when nobody is expected: the door card says so, and that the door
 * is hers to keep shut. Said of a ring only, never of somebody seen who did
 * not ring.
 */
export const NOBODY_EXPECTED_NOTICE = 'Nobody is expected at the door now. You don’t have to open.';

/**
 * Her day's line for an arranged visit once its visitor has said something
 * (edge today.mjs inlines this, and today.test.ts holds it to it).
 */
export function visitorDayLine(who: string, word: VisitorWord, arrangedByName: string | undefined): string {
  const first = firstNameOf(arrangedByName);
  const arranged = first ? ` ${first} arranged it.` : '';
  if (word.says === 'late') return `${opening(who)} will be about ${word.lateMinutes ?? VISIT_PASS_LIMITS.lateStepMinutes} minutes late.`;
  if (word.says === 'at_door') return `${opening(who)} says they are at your door.${arranged}`;
  return `${opening(who)} is on the way.${arranged}`;
}
