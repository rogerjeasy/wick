/**
 * errand-step: what each state of the errand machine does
 * (infra/errand.asl.json). Code decides; no model.
 *
 *   remind    her reminder, on her television at the next natural break
 *   arm       the door is told to wait: the task token is kept on the errand
 *   rang      somebody rang inside the window: recorded, and the member told
 *   no_show   the window passed with no ring: recorded, and the member told
 *   failed    a step failed every try: recorded, and the door no longer told
 *
 * Every action reads the errand again first, and acts only on the status it
 * is for. A called-off errand is never reminded and never reported on; a
 * step retried after it worked does not do it twice.
 *
 * Every action asks again whether the resident still allows the member who
 * arranged it (INV-9) — the errand stands on their word, as the roster entry
 * does (door/roster.ts stillWelcome). If not, nothing visible happens: the
 * door is no longer told to expect anyone, the errand is closed as
 * cancelled, and the execution ends. Nobody is told.
 *
 * What the member is told is a nudge with a kind and nothing else (INV-2,
 * packages/contracts push.ts): the words are read through get_errands, as
 * the member, past the Guardian.
 *
 * Pure: lambda.ts owns the clients.
 */
import { PUSH_KINDS, isErrandId, isErrandOpen, type ErrandStatus, type PushKind, type QueuedCard } from '@wick/contracts';
import type { ErrandStore, HeldErrand } from '../../store/errands.js';
import { MIN_DOOR_WAIT_SEC, doorWaitSeconds, windowEndOf } from './machine.js';
import { buildErrandReminder } from './reminder.js';

export const ERRAND_STEP_ACTIONS = ['remind', 'arm', 'rang', 'no_show', 'failed'] as const;
export type ErrandStepAction = (typeof ERRAND_STEP_ACTIONS)[number];

export type ErrandStepEvent =
  | { readonly action: 'remind' | 'no_show' | 'failed'; readonly householdId: string; readonly errandId: string }
  | { readonly action: 'arm'; readonly householdId: string; readonly errandId: string; readonly taskToken: string }
  | { readonly action: 'rang'; readonly householdId: string; readonly errandId: string; readonly rangAt: number; readonly cardId: string };

export interface ErrandStepDeps {
  readonly errands: ErrandStore;
  /** Whether the resident allows this member right now: their MEM# row, read again. */
  readonly isAllowed: (householdId: string, userId: string) => Promise<boolean>;
  /** egress.ts sendToDevice (INV-2). */
  readonly sendCard: (card: QueuedCard) => Promise<void>;
  /** egress.ts nudgeFamily: a kind, and nothing about the house. */
  readonly nudge: (userIds: readonly string[], kind: PushKind) => Promise<void>;
  /** Step Functions' SendTaskSuccess: the door step hands its own token back when there is nothing to wait for. */
  readonly handBack: (taskToken: string, output: object) => Promise<void>;
  readonly timeZone: string;
  readonly now: () => number;
}

/** What the machine passed, checked: it is read, not trusted. */
export function readStepEvent(raw: unknown): ErrandStepEvent | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const e = raw as Record<string, unknown>;
  if (typeof e.householdId !== 'string' || !e.householdId || !isErrandId(e.errandId)) return undefined;
  const ids = { householdId: e.householdId, errandId: e.errandId };
  switch (e.action) {
    case 'remind':
    case 'no_show':
    case 'failed':
      return { action: e.action, ...ids };
    case 'arm':
      return typeof e.taskToken === 'string' && e.taskToken ? { action: 'arm', ...ids, taskToken: e.taskToken } : undefined;
    case 'rang':
      return typeof e.rangAt === 'number' && Number.isFinite(e.rangAt) && typeof e.cardId === 'string'
        ? { action: 'rang', ...ids, rangAt: e.rangAt, cardId: e.cardId }
        : undefined;
    default:
      return undefined;
  }
}

const OPEN: readonly ErrandStatus[] = ['planned', 'reminded', 'waiting'];

/** A courtesy on top of what was recorded: a failure is logged, never the step's. */
async function tell(deps: ErrandStepDeps, errand: HeldErrand, kind: PushKind): Promise<void> {
  if (!errand.tellMe) return;
  try {
    await deps.nudge([errand.createdBy], kind);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'errand_nudge_failed', errandId: errand.errandId, err: err instanceof Error ? err.name : 'unknown' }));
  }
}

/** The author is no longer allowed: the door stops expecting anyone on their word, and the errand closes. Nobody is told. */
async function closeQuietly(deps: ErrandStepDeps, errand: HeldErrand): Promise<void> {
  await deps.errands.move(errand.householdId, errand.errandId, OPEN, 'cancelled', {}, { forgetToken: true });
  await deps.errands.forgetRoster(errand.householdId, errand.errandId);
  console.log(JSON.stringify({ level: 'info', msg: 'errand_author_not_allowed', errandId: errand.errandId }));
}

const stillAllowed = (deps: ErrandStepDeps, errand: HeldErrand): Promise<boolean> => deps.isAllowed(errand.householdId, errand.createdBy);

export async function handleErrandStep(raw: unknown, deps: ErrandStepDeps): Promise<Record<string, unknown>> {
  const event = readStepEvent(raw);
  // Thrown, so the execution fails loudly: only this machine calls the function, and it never sends this.
  if (!event) throw new Error('not an errand step');
  const { householdId, errandId } = event;
  const errand = await deps.errands.get(householdId, errandId);

  switch (event.action) {
    case 'remind': {
      const ended = { ended: true, doorWaitSeconds: MIN_DOOR_WAIT_SEC };
      if (!errand || (errand.status !== 'planned' && errand.status !== 'reminded')) return ended;
      if (!(await stillAllowed(deps, errand))) {
        await closeQuietly(deps, errand);
        return ended;
      }
      const now = deps.now();
      // A retry after the card went finds her reminded, and does not send it again.
      if (errand.status === 'planned') {
        await deps.sendCard(buildErrandReminder(errand, deps.timeZone, now));
        await deps.errands.move(householdId, errandId, ['planned'], 'reminded', { remindedAt: now });
      }
      return { ended: false, doorWaitSeconds: doorWaitSeconds(windowEndOf(errand), now) };
    }

    case 'arm': {
      const nothingToWaitFor = async (): Promise<Record<string, unknown>> => {
        await deps.handBack(event.taskToken, { ended: true });
        return { armed: false };
      };
      if (!errand || !isErrandOpen(errand.status)) return nothingToWaitFor();
      if (!(await stillAllowed(deps, errand))) {
        await closeQuietly(deps, errand);
        return nothingToWaitFor();
      }
      // A retried step brings a new token; the newest is the one the machine waits on.
      if (!(await deps.errands.move(householdId, errandId, OPEN, 'waiting', { taskToken: event.taskToken }))) return nothingToWaitFor();
      return { armed: true };
    }

    case 'rang':
    case 'no_show': {
      if (!errand || errand.status !== 'waiting') return { status: errand?.status ?? 'gone' };
      if (!(await stillAllowed(deps, errand))) {
        await closeQuietly(deps, errand);
        return { status: 'cancelled' };
      }
      const facts = event.action === 'rang' ? { rangAt: event.rangAt, cardId: event.cardId } : {};
      if (!(await deps.errands.move(householdId, errandId, ['waiting'], event.action, facts, { forgetToken: true }))) {
        return { status: (await deps.errands.get(householdId, errandId))?.status ?? 'gone' };
      }
      await tell(deps, errand, event.action === 'rang' ? PUSH_KINDS.errandRang : PUSH_KINDS.errandNoShow);
      return { status: event.action };
    }

    case 'failed': {
      if (!errand) return { status: 'gone' };
      if (!isErrandOpen(errand.status)) return { status: errand.status };
      await deps.errands.move(householdId, errandId, OPEN, 'failed', {}, { forgetToken: true });
      await deps.errands.forgetRoster(householdId, errandId);
      return { status: 'failed' };
    }
  }
}
