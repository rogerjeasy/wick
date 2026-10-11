import { describe, it, expect, vi } from 'vitest';
import type { RosterEntry } from '@wick/contracts';
import { cachedRoster } from '../rosterCache.js';

const maria: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE 06:51±30m' };
const tom: RosterEntry = { personId: 'tom', name: 'Tom', expectedPattern: 'FRI 10:00±30m' };

describe('cachedRoster', () => {
  it('never answers one household with another household\'s roster', async () => {
    const rosters: Record<string, RosterEntry[]> = { 'hh-a': [maria], 'hh-b': [tom] };
    const roster = cachedRoster({ load: async (householdId) => rosters[householdId] ?? [], now: () => 1_000 });

    expect(await roster('hh-a')).toEqual([maria]);
    expect(await roster('hh-b')).toEqual([tom]);
    expect(await roster('hh-a')).toEqual([maria]);
  });

  it('reads a household\'s roster once while it is fresh, and again once it is stale', async () => {
    let now = 1_000;
    const load = vi.fn(async (_householdId: string) => [maria]);
    const roster = cachedRoster({ load, cacheMs: 60_000, now: () => now });

    await roster('hh-a');
    now += 59_999;
    await roster('hh-a');
    expect(load).toHaveBeenCalledTimes(1);

    now += 1;
    await roster('hh-a');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
