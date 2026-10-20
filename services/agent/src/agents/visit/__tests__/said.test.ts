/**
 * What the visitor said from their visit pass, as the agent plane hears it
 * (said.ts): the member who arranged the visit is nudged, and a door card
 * already up for a ring around "I'm at the door" is told who is there.
 */
import { describe, expect, it, vi } from 'vitest';
import { PUSH_KINDS, type CardPatch, type PushKind } from '@wick/contracts';
import type { HeldErrand } from '../../../store/errands.js';
import { handleVisitSaid, visitSaidClaim, type VisitSaidDeps } from '../said.js';

const ERRAND = 'err_AAAAAAAAAAAAAAAAAAAA';
const NOW = Date.UTC(2026, 9, 22, 9, 0);

const rossi = (over: Partial<HeldErrand> = {}): HeldErrand => ({
  errandId: ERRAND,
  householdId: 'hh-1',
  createdBy: 'u_sarah',
  createdByName: 'Sarah Hughes',
  who: 'Doctor Rossi',
  at: NOW,
  windowMinutes: 60,
  tellMe: true,
  status: 'waiting',
  createdAt: NOW - 86_400_000,
  ...over,
});

function world(errand: HeldErrand | undefined, over: { allowed?: boolean; claimed?: Set<string> } = {}) {
  const nudged: { userIds: readonly string[]; kind: PushKind }[] = [];
  const patches: { patch: CardPatch; householdId: string }[] = [];
  const claimed = over.claimed ?? new Set<string>();
  const deps: VisitSaidDeps = {
    loadErrand: async (householdId, errandId) => (errand && householdId === errand.householdId && errandId === errand.errandId ? errand : undefined),
    isAllowed: async (householdId, userId) => householdId === 'hh-1' && userId === 'u_sarah' && over.allowed !== false,
    claimOnce: async (said) => {
      const key = `${said.householdId}/${said.errandId}/${said.says}/${said.at}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    nudge: async (userIds, kind) => void nudged.push({ userIds, kind }),
    sendPatch: async (patch, householdId) => void patches.push({ patch, householdId }),
  };
  return { deps, nudged, patches, claimed };
}

const said = (says: string, at = NOW - 60_000, over: Record<string, unknown> = {}) => ({ householdId: 'hh-1', errandId: ERRAND, says, at, ...over });

describe('handleVisitSaid — the member is told', () => {
  it('nudges the member who arranged it, with the kind for what was said and nothing else', async () => {
    for (const [says, kind] of [['on_way', PUSH_KINDS.visitorOnWay], ['late', PUSH_KINDS.visitorLate], ['at_door', PUSH_KINDS.visitorAtDoor]] as const) {
      const w = world(rossi());
      expect(await handleVisitSaid(said(says), w.deps)).toMatchObject({ nudged: true });
      expect(w.nudged).toEqual([{ userIds: ['u_sarah'], kind }]);
    }
  });

  it('nudges nobody when the member asked not to be told', async () => {
    const w = world(rossi({ tellMe: false }));
    expect(await handleVisitSaid(said('on_way'), w.deps)).toMatchObject({ nudged: false });
    expect(w.nudged).toEqual([]);
  });

  it('nudges once for one press, however often the bus delivers it', async () => {
    const w = world(rossi());
    await handleVisitSaid(said('on_way'), w.deps);
    await handleVisitSaid(said('on_way'), w.deps);
    expect(w.nudged).toHaveLength(1);
    // A second press is a second thing said.
    await handleVisitSaid(said('on_way', NOW - 30_000), w.deps);
    expect(w.nudged).toHaveLength(2);
  });

  it('does nothing for a member she no longer allows (INV-9)', async () => {
    const w = world(rossi({ rangAt: NOW - 30_000, cardId: 'door-abc', status: 'rang' }), { allowed: false });
    expect(await handleVisitSaid(said('at_door'), w.deps)).toBe('not_allowed');
    expect(w.nudged).toEqual([]);
    expect(w.patches).toEqual([]);
  });

  it('ignores an errand that is gone, one that has ended, and a detail that does not read', async () => {
    expect(await handleVisitSaid(said('on_way'), world(undefined).deps)).toBe('ignored');
    for (const status of ['cancelled', 'failed', 'no_show'] as const) {
      const w = world(rossi({ status }));
      expect(await handleVisitSaid(said('on_way'), w.deps)).toBe('ignored');
      expect(w.nudged).toEqual([]);
    }
    const w = world(rossi());
    for (const bad of [said('come_in'), said('on_way', Number.NaN), { ...said('on_way'), errandId: 'err_short' }, { ...said('on_way'), householdId: '' }, null]) {
      expect(await handleVisitSaid(bad, w.deps)).toBe('ignored');
    }
    expect(w.nudged).toEqual([]);
  });
});

describe('handleVisitSaid — a door card already up', () => {
  it('is told who is at the door when the ring was within ten minutes of "I’m at the door"', async () => {
    const w = world(rossi({ status: 'rang', rangAt: NOW - 3 * 60_000, cardId: 'door-abc' }));

    expect(await handleVisitSaid(said('at_door', NOW), w.deps)).toMatchObject({ patched: true });

    expect(w.patches).toEqual([{
      householdId: 'hh-1',
      patch: { cardId: 'door-abc', line: 'Doctor Rossi is at your door.', notice: 'They confirmed it on their phone just now. Sarah arranged this visit.' },
    }]);
  });

  it('says the same again on a redelivery: a patch puts the card where it already is', async () => {
    const w = world(rossi({ status: 'rang', rangAt: NOW - 3 * 60_000, cardId: 'door-abc' }));
    await handleVisitSaid(said('at_door', NOW), w.deps);
    await handleVisitSaid(said('at_door', NOW), w.deps);
    expect(w.patches[1]).toEqual(w.patches[0]);
    expect(w.nudged).toHaveLength(1);
  });

  it('is left alone for a ring further off than ten minutes, a ring not yet heard, or any other word', async () => {
    const far = world(rossi({ status: 'rang', rangAt: NOW - 11 * 60_000, cardId: 'door-abc' }));
    expect(await handleVisitSaid(said('at_door', NOW), far.deps)).toMatchObject({ patched: false });
    const notYet = world(rossi());
    expect(await handleVisitSaid(said('at_door', NOW), notYet.deps)).toMatchObject({ patched: false });
    const onWay = world(rossi({ status: 'rang', rangAt: NOW, cardId: 'door-abc' }));
    expect(await handleVisitSaid(said('on_way', NOW), onWay.deps)).toMatchObject({ patched: false });
    expect([...far.patches, ...notYet.patches, ...onWay.patches]).toEqual([]);
  });

  it('a nudge that fails costs the nudge, never the card', async () => {
    const w = world(rossi({ status: 'rang', rangAt: NOW, cardId: 'door-abc' }));
    const deps: VisitSaidDeps = { ...w.deps, nudge: async () => { throw new Error('push down'); } };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await handleVisitSaid(said('at_door', NOW), deps)).toEqual({ nudged: false, patched: true });

    expect(w.patches).toHaveLength(1);
    expect(error.mock.calls.flat().join(' ')).toContain('visit_said_nudge_failed');
    error.mockRestore();
  });
});

describe('visitSaidClaim — one press, one nudge', () => {
  it('is a row of its own for that press, put only if it is not there, and gone after a day', () => {
    expect(visitSaidClaim({ table: 'wick', householdId: 'hh-1', errandId: ERRAND, says: 'at_door', at: NOW })).toEqual({
      TableName: 'wick',
      Item: {
        pk: { S: 'HH#hh-1' },
        sk: { S: `VSAID#${ERRAND}#at_door#${NOW}` },
        ttl: { N: String(Math.floor(NOW / 1000) + 86_400) },
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });
});
