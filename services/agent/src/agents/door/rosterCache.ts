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

export interface CachedRosterOptions<T = RosterEntry> {
  readonly load: (householdId: string) => Promise<readonly T[]>;
  readonly cacheMs?: number;
  readonly now?: () => number;
}

/**
 * Also holds the names of the family circle for the door card's "Ask Sarah
 * to look" button, on the same terms: read rarely, kept per household. The
 * press itself reads the circle again (askFamily.ts), so a minute-old list
 * here can cost a button, never show a picture to someone since removed.
 */
export function cachedRoster<T = RosterEntry>(options: CachedRosterOptions<T>): (householdId: string) => Promise<readonly T[]> {
  const cacheMs = options.cacheMs ?? 60_000;
  const now = options.now ?? Date.now;
  const cached = new Map<string, { roster: readonly T[]; fetchedAt: number }>();

  return async (householdId) => {
    const hit = cached.get(householdId);
    if (hit && now() - hit.fetchedAt < cacheMs) return hit.roster;

    const roster = await options.load(householdId);
    cached.set(householdId, { roster, fetchedAt: now() });
    return roster;
  };
}
