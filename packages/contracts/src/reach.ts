/**
 * Hold for Sarah — the remote is the button she already holds.
 *
 * Holding OK for two seconds, anywhere in Wick, brings one card: "Ask Sarah
 * to ring you?". Yes tells one person — the first in her circle — that she
 * would like a call, and nothing else. If that person has not answered in
 * three minutes the next is asked, and so on to a neighbour, who is last.
 * "Just say hello" tells the same one person exactly that, and asks nobody
 * else. Whoever answers does so with a sentence chosen from the few below,
 * and it is shown on her television under their name.
 *
 * What it is not: a call, a camera, a microphone or an alarm. Nobody is
 * rung by Wick and no service is called. The card says so.
 *
 * One row per request: `HH#<household>` / `REACH#<reachId>`, written by the
 * agent plane when she presses (services/agent agents/reach) and read by the
 * family's get_reach_request / answer_reach_request tools. Its id is the
 * moment she held the button, as the edge's own clock had it, so the card
 * that asks, the row, and every later state of the card share one name.
 *
 * A request reaches people one at a time. Somebody not yet asked is told
 * nothing — not even that there is a request (wasAsked).
 */
import { MAX_CARD_DETAIL_CHARS, type CardAction, type QueuedCard } from './card.js';
import type { CircleRole } from './circle.js';

export const REACH_SK_PREFIX = 'REACH#';

/** The Reach card's actions. `ring_me` and `say_hello` keep the card: what happened next is written onto it. */
export const REACH_ACTIONS = {
  ring: 'ring_me',
  hello: 'say_hello',
  notNow: 'not_now',
  ok: 'ok',
} as const;

export type ReachKind = 'ring' | 'hello';

/** What a press asks for, or undefined for the way out and for any other button. */
export function reachKindOf(action: unknown): ReachKind | undefined {
  if (action === REACH_ACTIONS.ring) return 'ring';
  if (action === REACH_ACTIONS.hello) return 'hello';
  return undefined;
}

/** How long one person has to answer before the next is asked. `WAIT_WORDS` says the same. */
export const REACH_WAIT_MS = 3 * 60_000;
const WAIT_WORDS = 'three minutes';

/**
 * How long a request can still be under way. Holding the button again
 * within it shows where the request stands instead of starting another; past
 * it, something went wrong with the asking, and she is offered a new one.
 */
export const REACH_UNDER_WAY_MS = 30 * 60_000;

/** How long an unanswered request can still be answered: the rest of a day, not for ever. */
export const REACH_OPEN_MS = 12 * 60 * 60_000;

const REACH_CARD_PREFIX = 'reach-';
/** A moment in milliseconds, and nothing else: the id comes back from a television. */
const REACH_CARD_ID = /^reach-(\d{13,16})$/;

export function reachCardId(reachId: string): string {
  return `${REACH_CARD_PREFIX}${reachId}`;
}

/** The request a Reach card belongs to, or undefined for any other card. */
export function reachIdFromCardId(cardId: unknown): string | undefined {
  return typeof cardId === 'string' ? REACH_CARD_ID.exec(cardId)?.[1] : undefined;
}

/**
 * Everything a person can answer. Wick's own sentences, chosen and never
 * written, for the reason DOOR_ANSWERS gives: they are shown on the
 * resident's television under a family member's name. None says anyone is
 * coming, and none promises more than a telephone call.
 */
export const REACH_ANSWERS = {
  now: 'I’m ringing you now.',
  soon: 'I’ll ring you within the hour.',
  hello: 'Hello to you too.',
} as const;
export type ReachAnswer = keyof typeof REACH_ANSWERS;

export const isReachAnswer = (key: unknown): key is ReachAnswer => typeof key === 'string' && Object.hasOwn(REACH_ANSWERS, key);

/** The answers that fit a request: nobody answers a hello with "within the hour". */
export function answersFor(kind: ReachKind): readonly ReachAnswer[] {
  return kind === 'ring' ? ['now', 'soon'] : ['hello'];
}

/** Somebody who can be asked: who, by what name she knows them, and in what part. */
export interface ReachPerson {
  readonly userId: string;
  readonly name: string;
  readonly role: CircleRole;
}

const ROLE_RANK: Readonly<Record<CircleRole, number>> = { organiser: 0, family: 1, neighbour: 2 };

/**
 * The order of asking, from the people she allows: the organiser, then the
 * family in the order they came to her circle, and a neighbour last — the
 * family is who she would ring, the neighbour is who can come round.
 */
export function reachOrder(members: readonly (ReachPerson & { readonly since: number })[]): ReachPerson[] {
  return [...members]
    .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.since - b.since || a.userId.localeCompare(b.userId))
    .map(({ userId, name, role }) => ({ userId, name, role }));
}

export interface ReachRequest {
  readonly householdId: string;
  readonly reachId: string;
  readonly kind: ReachKind;
  /** When she pressed, by the server's clock. */
  readonly askedAt: number;
  /** Everyone who may be asked, in order, as her circle stood at the press. */
  readonly order: readonly ReachPerson[];
  /** How many of them have been asked so far. */
  readonly asked: number;
  readonly answer?: { readonly key: ReachAnswer; readonly by: string; readonly byName: string; readonly at: number };
  /** Everyone has been asked and the last wait is over. They can still answer. */
  readonly doneAt?: number;
}

/** The people a request has reached so far. */
export function reachAsked(request: ReachRequest): readonly ReachPerson[] {
  return request.order.slice(0, request.asked);
}

/** Whether this person has been asked. Anyone else is told nothing of the request. */
export function wasAsked(request: ReachRequest, userId: string): boolean {
  return reachAsked(request).some((person) => person.userId === userId);
}

/**
 * Whether somebody may yet be asked: a request to ring that is not answered,
 * not exhausted, and not long ago. Never a hello — nobody is asked after
 * the one person it went to, so there is nothing under way, and holding the
 * button again must offer a new request at once: she may want to be rung now.
 */
export function reachUnderWay(request: ReachRequest, now: number): boolean {
  return request.kind === 'ring' && request.answer === undefined && request.doneAt === undefined && now - request.askedAt < REACH_UNDER_WAY_MS;
}

const firstName = (name: string): string => name.trim().split(/\s+/)[0] || 'Someone';

/** "Sarah", "Sarah and David", "Sarah, David and Tom". */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The first wording that fits a card's body (card.ts MAX_CARD_DETAIL_CHARS); the last is always short enough. */
const fitting = (...wordings: readonly string[]): string => wordings.find((w) => w.length <= MAX_CARD_DETAIL_CHARS) ?? wordings.at(-1)!;

interface Words {
  readonly headline: string;
  readonly detail?: string;
  readonly actions: readonly CardAction[];
}

const allRight: CardAction = { id: REACH_ACTIONS.ok, label: 'All right', kind: 'primary' };
const thankYou: CardAction = { id: REACH_ACTIONS.ok, label: 'Thank you', kind: 'primary' };

function reachCard(householdId: string, reachId: string, words: Words, now: number): QueuedCard {
  const id = reachCardId(reachId);
  return {
    id,
    // Deferred like a note (INV-5). It is on screen at once only because she
    // has just asked for it (apps/tv-vega home/reach.ts); anything written
    // onto it after she put it away waits for a break like everything else.
    urgency: 'DEFERRED',
    queuedAt: now,
    shownCount: 0,
    card: {
      type: 'REACH',
      id,
      householdId,
      correlationId: id,
      createdAt: now,
      headline: words.headline,
      ...(words.detail === undefined ? {} : { detail: words.detail }),
      actions: words.actions,
    },
  };
}

/**
 * The card her hold brings: who would be asked, what they would be told,
 * and the three things she can do. Written by the edge on the television
 * that was held (edge-device reach.mjs keeps a copy of these words, held to
 * this one by its tests). With nobody to ask, it says so and offers nothing.
 */
export function buildReachAskCard(input: { readonly householdId: string; readonly reachId: string; readonly first?: ReachPerson | undefined; readonly now: number }): QueuedCard {
  const { householdId, reachId, first, now } = input;
  if (!first) {
    return reachCard(householdId, reachId, {
      headline: 'There is nobody Wick can ask just now.',
      detail: 'When you have allowed someone in your family circle, you can ask them here to ring you.',
      actions: [allRight],
    }, now);
  }
  const name = firstName(first.name);
  return reachCard(householdId, reachId, {
    headline: `Ask ${name} to ring you?`,
    detail: `${name} will be told only that you would like a call. Wick does not call for help: in an emergency, use the telephone.`,
    actions: [
      { id: REACH_ACTIONS.ring, label: `Yes, ask ${name}`, kind: 'primary' },
      { id: REACH_ACTIONS.hello, label: 'Just say hello', kind: 'secondary' },
      // The way out, and last: holding the button commits her to nothing.
      { id: REACH_ACTIONS.notNow, label: 'No, not now', kind: 'dismiss' },
    ],
  }, now);
}

function statusWords(request: ReachRequest): Words {
  const asked = reachAsked(request).map((person) => firstName(person.name));
  const latest = asked.at(-1) ?? 'Someone';

  if (request.answer) {
    return { headline: `${firstName(request.answer.byName)} says: ${REACH_ANSWERS[request.answer.key]}`, actions: [thankYou] };
  }
  if (request.kind === 'hello') {
    return { headline: `${latest} has been told you said hello.`, actions: [allRight] };
  }
  if (request.doneAt !== undefined) {
    const one = asked.length === 1;
    return {
      headline: 'Nobody has answered yet.',
      detail: fitting(
        `${listNames(asked)} ${one ? 'has' : 'have'} been asked, and can still answer. Wick will tell you here if ${one ? `${latest} does` : 'one of them does'}.`,
        'Everyone Wick can ask has been asked, and can still answer. Wick will tell you here if one of them does.',
      ),
      actions: [allRight],
    };
  }

  const next = request.order[request.asked];
  const nextName = next ? firstName(next.name) : undefined;
  if (asked.length <= 1) {
    return {
      headline: `${latest} has been asked to ring you.`,
      detail: nextName
        ? `If ${latest} has not answered in ${WAIT_WORDS}, Wick will ask ${nextName}.`
        : `Wick will tell you here when ${latest} answers.`,
      actions: [allRight],
    };
  }

  const earlier = asked.slice(0, -1);
  const then = nextName
    ? `If nobody has answered in ${WAIT_WORDS}, Wick will ask ${nextName}.`
    : 'Wick will tell you here when somebody answers.';
  return {
    headline: `${latest} has been asked to ring you as well.`,
    detail: fitting(
      `${listNames(earlier)} ${earlier.length === 1 ? 'has' : 'have'} not answered yet. ${then}`,
      `Nobody asked before ${latest} has answered yet. ${then}`,
      'Nobody has answered yet.',
    ),
    actions: [allRight],
  };
}

/**
 * The card as a request now stands: who has been asked, who is next, or
 * what was answered. The same id as the card she pressed, so it is replaced
 * in place while she has it open, and comes back at a break if she had put
 * it away.
 */
export function buildReachCard(request: ReachRequest, now: number): QueuedCard {
  return reachCard(request.householdId, request.reachId, statusWords(request), now);
}
