/**
 * "The week is ready to read" — a Web Push to the family the moment she has
 * read her week on her own television, and not before (INV-7).
 *
 * Her press on the week card is what makes the week readable: the edge sets
 * residentSeenAt (edge-device device-event.mjs) and, the first time only,
 * puts `wick.device` / `week.seen` on the bus. That event comes here
 * (actionLambda.ts), because only the agent plane may reach a family
 * member's browser (egress.ts nudgeFamily, INV-2).
 *
 * The nudge carries the kind `week_ready` and nothing else — no name, no
 * week, no sentence (packages/contracts push.ts); the family app reads the
 * week, and its one suggestion, through get_week_narrative as ever. It goes
 * to the family she allows, never to a neighbour, and to nobody when she
 * keeps the shape of her week to herself: there would be nothing to read.
 */
import { PUSH_KINDS, type PushKind } from '@wick/contracts';
import { familyOnly, type FamilyMember } from '../door/askFamily.js';

export interface WeekReadyDeps {
  /** Everyone she allows (store/looks.ts listFamily); neighbours are left out here. */
  readonly listFamily: (householdId: string) => Promise<readonly FamilyMember[]>;
  /** Whether she shares the shape of her week (the RHYTHM class) with the family at all. */
  readonly weekShared: (householdId: string) => Promise<boolean>;
  readonly nudge: (userIds: readonly string[], kind: PushKind) => Promise<void>;
}

export type WeekReadyResult = { readonly result: 'nudged'; readonly members: number } | { readonly result: 'ignored' | 'private' | 'nobody' };

const ISO_WEEK = /^\d{4}-W\d{2}$/;

export async function tellWeekReady(detail: Record<string, unknown>, deps: WeekReadyDeps): Promise<WeekReadyResult> {
  const { householdId, isoWeek } = detail;
  if (typeof householdId !== 'string' || !householdId || typeof isoWeek !== 'string' || !ISO_WEEK.test(isoWeek)) return { result: 'ignored' };
  if (!(await deps.weekShared(householdId))) return { result: 'private' };
  const family = familyOnly(await deps.listFamily(householdId));
  if (family.length === 0) return { result: 'nobody' };
  await deps.nudge(family.map((member) => member.userId), PUSH_KINDS.weekReady);
  return { result: 'nudged', members: family.length };
}
