/**
 * Hold for Sarah — three minutes on, and no answer (packages/contracts
 * reach.ts).
 *
 * The timer ask.ts set has fired (timer.ts). If nobody has answered, the
 * next person in her circle is asked: the family first, a neighbour last.
 * When the last person's three minutes are over, she is told that nobody
 * has answered yet — and that they still can.
 *
 * The same care as the press. The row is read again, and a timer that has
 * been overtaken — answered, already moved on, already finished — does
 * nothing. The circle is read again too: somebody she has removed since she
 * pressed is passed over and never named as asked (INV-9). And the moving
 * on is one conditional write, so two timers cannot both ask the same
 * person.
 *
 * Only the person newly asked is nudged. Those asked before were told
 * already; those after are told nothing yet.
 */
import { PUSH_KINDS, REACH_WAIT_MS, buildReachCard, reachIdFromCardId, reachCardId, type PushKind, type QueuedCard, type ReachPerson, type ReachRequest } from '@wick/contracts';
import { attempt, type ReachDue } from './ask.js';

export interface ReachDueDeps {
  readonly load: (householdId: string, reachId: string) => Promise<ReachRequest | undefined>;
  readonly listCircle: (householdId: string) => Promise<readonly (ReachPerson & { readonly since: number })[]>;
  /** One more person asked, with the order as it now stands. False when somebody answered, or another timer got there first. */
  readonly advance: (householdId: string, reachId: string, from: number, order: readonly ReachPerson[]) => Promise<boolean>;
  /** Everyone has been asked in vain. False when somebody answered first. */
  readonly finish: (householdId: string, reachId: string, at: number) => Promise<boolean>;
  readonly sendCard: (card: QueuedCard) => Promise<void>;
  readonly nudge: (userIds: readonly string[], kind: PushKind) => Promise<void>;
  readonly schedule: (due: ReachDue) => Promise<void>;
  readonly now: () => number;
}

export type ReachDueResult = 'asked_next' | 'exhausted' | 'settled' | 'ignored';

/** What a timer carries, checked: it arrives from outside this code. */
function parseDue(raw: Record<string, unknown>): { householdId: string; reachId: string; step: number } | undefined {
  const { householdId, reachId, step } = raw;
  if (typeof householdId !== 'string' || !householdId || typeof reachId !== 'string') return undefined;
  if (reachIdFromCardId(reachCardId(reachId)) !== reachId) return undefined;
  if (typeof step !== 'number' || !Number.isInteger(step) || step < 1) return undefined;
  return { householdId, reachId, step };
}

export async function handleReachDue(raw: Record<string, unknown>, deps: ReachDueDeps): Promise<ReachDueResult> {
  const due = parseDue(raw);
  if (!due) return 'ignored';
  const { householdId, reachId, step } = due;

  const request = await deps.load(householdId, reachId);
  // Answered, finished, moved on by another timer, or never a request to ring.
  if (!request || request.kind !== 'ring' || request.answer || request.doneAt !== undefined || request.asked !== step) return 'settled';

  const now = deps.now();
  const stillAllowed = new Set((await deps.listCircle(householdId)).map((person) => person.userId));
  const waiting = request.order.slice(request.asked).filter((person) => stillAllowed.has(person.userId));
  const next = waiting[0];

  if (!next) {
    if (!(await deps.finish(householdId, reachId, now))) return 'settled';
    await attempt('reach_card_not_sent', () => deps.sendCard(buildReachCard({ ...request, doneAt: now }, now)));
    return 'exhausted';
  }

  // The order as it now stands: those already asked, then those who still can be.
  const order = [...request.order.slice(0, request.asked), ...waiting];
  if (!(await deps.advance(householdId, reachId, step, order))) return 'settled';

  const moved: ReachRequest = { ...request, order, asked: step + 1 };
  await attempt('reach_card_not_sent', () => deps.sendCard(buildReachCard(moved, now)));
  await attempt('reach_nudge_failed', () => deps.nudge([next.userId], PUSH_KINDS.reachRing));
  // Always one more: after the last person, it is what says nobody has answered.
  await attempt('reach_timer_not_set', () => deps.schedule({ householdId, reachId, step: step + 1, at: now + REACH_WAIT_MS }));
  return 'asked_next';
}
