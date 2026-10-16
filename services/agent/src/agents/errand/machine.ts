/**
 * What the errand state machine (infra/errand.asl.json) is started with,
 * and the one sum it cannot do itself.
 *
 * The execution is named by the errand's id, so starting it twice is the
 * same execution (Step Functions refuses a second with that name). Its
 * input names the errand and the moments — never who is coming or who
 * arranged it: an execution's input is shown in the console and kept in
 * its history, and what it needs is read from the row at each step.
 *
 * Step Functions has no date arithmetic. A Wait state waits until a moment
 * given as text (`TimestampPath`), and a task's timeout is a number of
 * seconds from when the task starts (`TimeoutSecondsPath`). So the seconds
 * the door waits are worked out here — at the start, for an errand with no
 * reminder, and again by the reminder step for one with (errand-step).
 */
import type { Errand } from '@wick/contracts';

/** A wait armed after the window has nearly gone still waits this long: a ring a moment late is still a ring. */
export const MIN_DOOR_WAIT_SEC = 60;

export interface ErrandExecutionInput {
  readonly householdId: string;
  readonly errandId: string;
  /** When to remind her; absent, the machine goes straight to the door. */
  readonly remindAt?: string;
  readonly windowEnd: string;
  readonly door: { readonly waitSeconds: number };
}

/** A moment as a Wait state's `TimestampPath` reads it: ISO 8601 to the second, rounded up so it is never early. */
export function instant(ms: number): string {
  return new Date(Math.ceil(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

export const windowEndOf = (errand: Pick<Errand, 'at' | 'windowMinutes'>): number => errand.at + errand.windowMinutes * 60_000;

/** Seconds from `now` to the end of the window, rounded up, and never under a minute. */
export function doorWaitSeconds(windowEnd: number, now: number): number {
  return Math.max(MIN_DOOR_WAIT_SEC, Math.ceil((windowEnd - now) / 1000));
}

export function executionInput(errand: Errand, now: number): ErrandExecutionInput {
  const windowEnd = windowEndOf(errand);
  return {
    householdId: errand.householdId,
    errandId: errand.errandId,
    ...(errand.remindAt === undefined ? {} : { remindAt: instant(errand.remindAt) }),
    windowEnd: instant(windowEnd),
    door: { waitSeconds: doorWaitSeconds(windowEnd, now) },
  };
}
