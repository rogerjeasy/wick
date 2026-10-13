/**
 * Hold for Sarah — the three minutes (packages/contracts reach.ts).
 *
 * One person has three minutes to answer before the next is asked (due.ts).
 * Nothing in Wick is running in between: the wait is a one-time schedule in
 * Amazon EventBridge Scheduler that calls the card-action function back at
 * that moment and then deletes itself.
 *
 * What it carries is which request and which step — never who was asked,
 * and never who is next. Its name is the request, the step, and a digest of
 * the household, so setting the same timer twice is refused by the service
 * rather than fired twice, and a schedule's name says nothing about a home.
 *
 * Pure: actionLambda.ts owns the client.
 */
import { createHash } from 'node:crypto';
import type { ReachDue } from './ask.js';

export const REACH_DUE = 'reach.due';

/** The event the timer hands the card-action function: shaped like one from the bus, so it is routed the same way. */
export function reachDueEvent(due: Pick<ReachDue, 'householdId' | 'reachId' | 'step'>): { readonly 'detail-type': typeof REACH_DUE; readonly detail: { householdId: string; reachId: string; step: number } } {
  return { 'detail-type': REACH_DUE, detail: { householdId: due.householdId, reachId: due.reachId, step: due.step } };
}

/** `at(yyyy-mm-ddThh:mm:ss)`, rounded up to the second: never a moment early. */
function atExpression(at: number): string {
  return `at(${new Date(Math.ceil(at / 1000) * 1000).toISOString().slice(0, 19)})`;
}

export interface ReachTimerTarget {
  /** The card-action function. */
  readonly targetArn: string;
  /** The role the scheduler takes to call it. */
  readonly roleArn: string;
  readonly group: string;
}

/** CreateSchedule input for one firing. */
export function reachDueSchedule(input: ReachTimerTarget & { readonly due: ReachDue }) {
  const { due } = input;
  const household = createHash('sha256').update(due.householdId).digest('hex').slice(0, 16);
  return {
    Name: `reach-${due.reachId}-${due.step}-${household}`,
    GroupName: input.group,
    ScheduleExpression: atExpression(due.at),
    ScheduleExpressionTimezone: 'UTC',
    FlexibleTimeWindow: { Mode: 'OFF' as const },
    ActionAfterCompletion: 'DELETE' as const,
    Target: {
      Arn: input.targetArn,
      RoleArn: input.roleArn,
      Input: JSON.stringify(reachDueEvent(due)),
    },
  };
}
