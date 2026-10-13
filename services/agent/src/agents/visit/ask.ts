/**
 * The visit, witnessed — the asking (packages/contracts visit.ts).
 *
 * When a television says its resident is there (the same signal "Shall I
 * tell Sarah?" waits for), any visit that is ready is put to her: the
 * visitor has been gone a little while, or was never seen leaving and long
 * enough has passed. The card is deferred like a note, so it reaches her at
 * a natural break.
 *
 * Each visit is asked about once. The asking is claimed before the card is
 * sent, so two televisions' signals cannot put it on screen twice; if the
 * card then cannot be sent the claim is undone, so she is asked next time
 * rather than never. A demo home's simulated history is never asked about:
 * its visits are seeded already answered (mcp-server accounts/demoHome.ts),
 * and the question comes only after a ring at that home's own door.
 */
import { VISIT_ASK_WITHIN_MS, buildVisitCard, readyToAsk, visitId, type QueuedCard, type Visit } from '@wick/contracts';

export interface AskVisitDeps {
  readonly recent: (householdId: string, since: number) => Promise<readonly Visit[]>;
  readonly claimAsk: (visit: Visit, at: number) => Promise<boolean>;
  readonly releaseAsk: (visit: Visit) => Promise<void>;
  readonly sendCard: (card: QueuedCard) => Promise<void>;
  readonly now: () => number;
  /** Where the house is: the times on the card are the house's own. */
  readonly timeZone: string;
}

/** Puts every visit that is ready to her. Returns the ones asked about now. */
export async function askAboutVisits(householdId: string, deps: AskVisitDeps): Promise<readonly string[]> {
  const now = deps.now();
  const asked: string[] = [];
  for (const visit of await deps.recent(householdId, now - VISIT_ASK_WITHIN_MS)) {
    if (!readyToAsk(visit, now)) continue;
    if (!(await deps.claimAsk(visit, now))) continue;
    try {
      await deps.sendCard(buildVisitCard(visit, deps.timeZone, now));
      asked.push(visitId(visit));
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'visit_card_not_sent', err: err instanceof Error ? err.name : 'unknown' }));
      await deps.releaseAsk(visit);
    }
  }
  return asked;
}
