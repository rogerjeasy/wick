/**
 * `brief.weekly` — the Sunday brief for one home (graphs/weeklyBrief.ts).
 *
 * Payload `{ householdId, isoWeek }`. The household is the session's
 * (runtime/invoke.ts: session = household), sent by the brief's worker
 * Lambda for a home with a television, or by the Wick server for a demo
 * home it has just made.
 *
 * Idempotent, so a message delivered twice is harmless: the row is read
 * first, and a week the agents already wrote, or one she has already read,
 * is left as it is (agents/brief/store.ts briefDecision) — with one repair.
 * A week the agents wrote that she has not read yet is sent to her
 * television again: that is how a retry heals a week card that was not
 * sent the first time (INV-7: until she reads it, the family cannot).
 *
 * Kept apart from handlers.ts only so the two can change without meeting;
 * main.ts registers it beside the others.
 */
import type { WeekNarrative } from '@wick/contracts';
import { briefDecision, type WeekStore } from '../agents/brief/store.js';
import type { GraphRun } from '../graphs/doorAction.js';
import type { BriefInput, BriefOutcome } from '../graphs/weeklyBrief.js';
import type { RuntimeHandler } from './server.js';

export const BRIEF_WEEKLY_KIND = 'brief.weekly';

const ISO_WEEK = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

export type BriefRun = (input: BriefInput) => Promise<GraphRun<BriefOutcome>>;

export interface BriefHandlerDeps {
  readonly weeks: WeekStore;
  /** The graph, with its real deps (main.ts). */
  readonly run: BriefRun;
  /** Her copy, on her own television (narrator/weekCard.ts). */
  readonly sendWeekCard: (narrative: WeekNarrative) => Promise<void>;
}

export function briefWeeklyHandler(depsFor: (householdId: string) => BriefHandlerDeps): RuntimeHandler {
  return async (payload) => {
    const { householdId, isoWeek } = payload;
    if (typeof householdId !== 'string' || !householdId || typeof isoWeek !== 'string' || !ISO_WEEK.test(isoWeek)) return { status: 'bad_request' };
    const deps = depsFor(householdId);

    const existing = await deps.weeks.load(householdId, isoWeek);
    const decision = briefDecision(existing);
    if (!decision.write) {
      const week = existing!.narrative;
      if (decision.why === 'already_written' && !week.simulated && week.residentSeenAt === undefined) {
        await deps.sendWeekCard(week);
        return { status: 'skipped', why: decision.why, cardSent: true };
      }
      return { status: 'skipped', why: decision.why };
    }

    const run = await deps.run({
      householdId,
      isoWeek,
      ...(existing ? { existing } : {}),
      ...(decision.keep ? { keep: decision.keep } : {}),
    });
    console.log(JSON.stringify({ level: run.result.status === 'failed' ? 'error' : 'info', msg: 'brief_weekly', isoWeek, status: run.result.status, path: run.path }));
    return { ...run.result, path: run.path };
  };
}
