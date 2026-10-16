import { describe, expect, it } from 'vitest';
import { PUSH_KINDS, type PushKind } from '@wick/contracts';
import { tellWeekReady, type WeekReadyDeps } from '../weekReady.js';
import type { FamilyMember } from '../../door/askFamily.js';

const SARAH: FamilyMember = { userId: 'u-sarah', name: 'Sarah', role: 'family' };
const TOM: FamilyMember = { userId: 'u-tom', name: 'Tom' };
const NEIGHBOUR: FamilyMember = { userId: 'u-nell', name: 'Nell', role: 'neighbour' };

function deps(over: Partial<WeekReadyDeps> = {}) {
  const nudged: { userIds: readonly string[]; kind: PushKind }[] = [];
  const d: WeekReadyDeps = {
    listFamily: async () => [SARAH, TOM, NEIGHBOUR],
    weekShared: async () => true,
    nudge: async (userIds, kind) => void nudged.push({ userIds, kind }),
    ...over,
  };
  return { d, nudged };
}

describe('tellWeekReady — she has read her week, so the family may: they are told it is there', () => {
  it('nudges the family she allows, with the kind week_ready and nothing else', async () => {
    const { d, nudged } = deps();

    expect(await tellWeekReady({ householdId: 'hh-1', isoWeek: '2026-W38', at: 5 }, d)).toEqual({ result: 'nudged', members: 2 });
    expect(nudged).toEqual([{ userIds: ['u-sarah', 'u-tom'], kind: PUSH_KINDS.weekReady }]);
  });

  it('never tells a neighbour: the week is not theirs to read', async () => {
    const { d, nudged } = deps({ listFamily: async () => [NEIGHBOUR] });
    expect(await tellWeekReady({ householdId: 'hh-1', isoWeek: '2026-W38' }, d)).toEqual({ result: 'nobody' });
    expect(nudged).toEqual([]);
  });

  it('tells nobody when she keeps her week to herself: there is nothing for them to read', async () => {
    const { d, nudged } = deps({ weekShared: async () => false });
    expect(await tellWeekReady({ householdId: 'hh-1', isoWeek: '2026-W38' }, d)).toEqual({ result: 'private' });
    expect(nudged).toEqual([]);
  });

  it('ignores an event that names no household or no week', async () => {
    const { d, nudged } = deps();
    expect(await tellWeekReady({ isoWeek: '2026-W38' }, d)).toEqual({ result: 'ignored' });
    expect(await tellWeekReady({ householdId: 'hh-1', isoWeek: 'today' }, d)).toEqual({ result: 'ignored' });
    expect(nudged).toEqual([]);
  });
});
