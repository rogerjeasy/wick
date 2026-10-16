/**
 * errand-door: the doorbell rang, and an errand may be waiting for it.
 *
 *   door Lambda -> EventBridge (wick.door / door.rang) -> (this)
 *     -> each waiting errand of that home whose window holds the ring
 *     -> Step Functions SendTaskSuccess({ rangAt, cardId }) -> errand-step `rang`
 *
 * A ring is matched by its time, as the door card's "This looks like the
 * plumber" is (door/roster.ts): within the errand's window either side of
 * the moment given. It says nothing of who rang, and neither does anything
 * after it ("Someone rang around when the plumber was expected").
 *
 * Only the household the ring was at is read: the event comes from the door
 * Lambda, which took the household from the doorbell (INV-8). And each
 * token is handed back once: a second ring finds it spent, and Step
 * Functions' own answer that a token is over lets it go. A token that could
 * not be handed back for any other reason fails the invocation after the
 * rest are told, so EventBridge tries again — and finds those already spent.
 *
 * Pure: lambda.ts owns the clients.
 */
import { readDoorRangDetail } from '@wick/contracts';
import type { ErrandStore } from '../../store/errands.js';

export interface ErrandDoorDeps {
  readonly errands: ErrandStore;
  /** Step Functions' SendTaskSuccess. */
  readonly handBack: (taskToken: string, output: object) => Promise<void>;
}

/** Step Functions' words for a token that has nothing left to wake. */
const OVER = new Set(['TaskDoesNotExist', 'TaskTimedOut', 'InvalidToken']);

export async function handleDoorRang(detail: unknown, deps: ErrandDoorDeps): Promise<{ readonly told: number; readonly spent: number } | 'ignored'> {
  const ring = readDoorRangDetail(detail);
  if (!ring) return 'ignored';

  const waiting = (await deps.errands.list(ring.householdId)).filter(
    (errand) => errand.status === 'waiting' && Math.abs(ring.at - errand.at) <= errand.windowMinutes * 60_000,
  );

  let told = 0;
  let spent = 0;
  const failed: unknown[] = [];
  for (const { errandId } of waiting) {
    const token = (await deps.errands.get(ring.householdId, errandId))?.taskToken;
    if (!token) continue;
    try {
      await deps.handBack(token, { rangAt: ring.at, cardId: ring.cardId });
      told += 1;
    } catch (err) {
      if (!OVER.has((err as { name?: string }).name ?? '')) {
        failed.push(err);
        continue;
      }
      spent += 1;
    }
    await deps.errands.spendToken(ring.householdId, errandId, token);
  }

  console.log(JSON.stringify({ level: 'info', msg: 'errand_door_rang', told, spent, failed: failed.length }));
  if (failed.length) throw failed[0];
  return { told, spent };
}
