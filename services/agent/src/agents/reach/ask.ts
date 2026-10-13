/**
 * Hold for Sarah — her press (packages/contracts reach.ts).
 *
 * She held OK, the card offered to ask someone to ring her, and she said
 * yes — or chose "Just say hello". This carries that out, and nothing here
 * is decided by a model: who is asked is the first person in her circle as
 * it stands at the press (INV-9), read again and never trusted from when
 * the card was drawn.
 *
 * The order is the argument. The request is filed first, once, under the id
 * the card already carries, so a double press or a redelivered one asks
 * nobody twice. Then she is told who was asked, on the card she pressed.
 * Then that one person's own browsers are nudged — with a kind and nothing
 * about the house (egress.ts nudgeFamily). Then the three minutes are set
 * going (timer.ts), after which due.ts asks the next person.
 *
 * Nothing after the filing can undo it: a card that could not be drawn, a
 * browser that could not be reached and a timer that could not be set are
 * each logged and passed over. She asked; the request stands and can be
 * read by the person it was for (the family's get_reach_request).
 *
 * The press is the consent, as on the door card: nobody is told anything
 * because Wick thought they should be.
 */
import { PUSH_KINDS, REACH_WAIT_MS, buildReachAskCard, buildReachCard, reachIdFromCardId, reachKindOf, reachOrder, type PushKind, type QueuedCard, type ReachPerson, type ReachRequest } from '@wick/contracts';
import { parseCardAction } from '../door/actions.js';

/** One firing of the three-minute timer: which request, and how many people had been asked when it was set. */
export interface ReachDue {
  readonly householdId: string;
  readonly reachId: string;
  readonly step: number;
  readonly at: number;
}

export interface ReachAskDeps {
  /** The people the resident allows right now, with when each came to her circle. */
  readonly listCircle: (householdId: string) => Promise<readonly (ReachPerson & { readonly since: number })[]>;
  /** Conditional write of REACH#<reachId>; false when it already existed. */
  readonly claimOnce: (request: ReachRequest) => Promise<boolean>;
  readonly sendCard: (card: QueuedCard) => Promise<void>;
  /** Tells those people's own browsers there is something to open Wick for. It carries nothing about the house. */
  readonly nudge: (userIds: readonly string[], kind: PushKind) => Promise<void>;
  readonly schedule: (due: ReachDue) => Promise<void>;
  readonly now: () => number;
}

export type ReachAskResult = 'asked' | 'nobody' | 'duplicate' | 'ignored';

/** Logged and passed over: see this file's header for why nothing after the filing may fail the press. */
export async function attempt(what: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: what, err: err instanceof Error ? err.name : 'unknown' }));
  }
}

export async function handleReachAsk(raw: Record<string, unknown>, deps: ReachAskDeps): Promise<ReachAskResult> {
  const detail = parseCardAction(raw);
  const reachId = detail ? reachIdFromCardId(detail.cardId) : undefined;
  const kind = detail ? reachKindOf(detail.action) : undefined;
  if (!detail || !detail.householdId || !reachId || !kind) return 'ignored';
  const { householdId } = detail;

  const now = deps.now();
  const order = reachOrder(await deps.listCircle(householdId));
  const first = order[0];
  if (!first) {
    // The offer named somebody who has since gone. She still hears back, plainly.
    await attempt('reach_nobody_card_not_sent', () => deps.sendCard(buildReachAskCard({ householdId, reachId, now })));
    return 'nobody';
  }

  const request: ReachRequest = {
    householdId,
    reachId,
    kind,
    askedAt: now,
    // A hello is for one person: nobody is asked after them.
    order: kind === 'hello' ? [first] : order,
    asked: 1,
  };
  if (!(await deps.claimOnce(request))) return 'duplicate';

  await attempt('reach_card_not_sent', () => deps.sendCard(buildReachCard(request, now)));
  await attempt('reach_nudge_failed', () => deps.nudge([first.userId], kind === 'ring' ? PUSH_KINDS.reachRing : PUSH_KINDS.reachHello));
  if (kind === 'ring') {
    await attempt('reach_timer_not_set', () => deps.schedule({ householdId, reachId, step: 1, at: now + REACH_WAIT_MS }));
  }
  return 'asked';
}
