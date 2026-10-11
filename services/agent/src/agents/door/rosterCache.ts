/**
 * M4's roster, container-cached like deviceCache.ts's device list — a
 * household curates this rarely, and Phase 1 shouldn't pay a DynamoDB round
 * trip on every warm invocation just to usually find nobody scheduled.
 *
 * Kept per household. One Lambda container serves every household's rings,
 * and a roster answered from another home's cache would tell a resident
 * that a stranger at their door is someone they expect.
 */
import type { RosterEntry } from '@wick/contracts';

export interface CachedRosterOptions {
  readonly load: (householdId: string) => Promise<readonly RosterEntry[]>;
  readonly cacheMs?: number;
  readonly now?: () => number;
}

export function cachedRoster(options: CachedRosterOptions): (householdId: string) => Promise<readonly RosterEntry[]> {
  const cacheMs = options.cacheMs ?? 60_000;
  const now = options.now ?? Date.now;
  const cached = new Map<string, { roster: readonly RosterEntry[]; fetchedAt: number }>();

  return async (householdId) => {
    const hit = cached.get(householdId);
    if (hit && now() - hit.fetchedAt < cacheMs) return hit.roster;

    const roster = await options.load(householdId);
    cached.set(householdId, { roster, fetchedAt: now() });
    return roster;
  };
}
