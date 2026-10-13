import { describe, expect, it } from 'vitest';
import {
  REACH_ACTIONS as CONTRACT_ACTIONS,
  REACH_SK_PREFIX as CONTRACT_SK_PREFIX,
  REACH_UNDER_WAY_MS,
  buildReachAskCard as contractAskCard,
  reachCardId,
  reachOrder,
  type CircleRole,
} from '@wick/contracts';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { REACH_ACTIONS, REACH_SK_PREFIX, buildReachAskCard, firstToAsk, isReachEvent, latestReach, reachUnderWayId, storedCardKey } from '../reach.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { retiresCard } from '../card-acted.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { announcesRetirement, shouldPublish } from '../card-action-event.mjs';

const NOW = Date.UTC(2026, 9, 13, 14, 0);
const REACH_ID = String(NOW);

const member = (userId: string, name: string, role: CircleRole, requestedAt: number, status = 'allowed') => ({
  pk: { S: 'HH#hh-1' },
  sk: { S: `MEM#${userId}` },
  name: { S: name },
  role: { S: role },
  status: { S: status },
  requestedAt: { N: String(requestedAt) },
});

const reachRow = (askedAt: number, over: Record<string, { N: string } | { S: string }> = {}) => ({
  pk: { S: 'HH#hh-1' },
  sk: { S: `REACH#${askedAt}` },
  reachId: { S: String(askedAt) },
  askedAt: { N: String(askedAt) },
  ...over,
});

describe('held to the contract', () => {
  it('uses the same rows and the same buttons as the rest of Wick', () => {
    expect(REACH_SK_PREFIX).toBe(CONTRACT_SK_PREFIX);
    expect(REACH_ACTIONS).toEqual(CONTRACT_ACTIONS);
  });

  it('writes the asking card word for word as the contract does', () => {
    const sarah = { userId: 'u_sarah', name: 'Sarah Hughes', role: 'organiser' as const };
    for (const first of [sarah, undefined]) {
      expect(buildReachAskCard({ householdId: 'hh-1', reachId: REACH_ID, first, now: NOW })).toEqual(
        contractAskCard({ householdId: 'hh-1', reachId: REACH_ID, first, now: NOW }),
      );
    }
  });

  it('would ask the same person first as the agent plane will', () => {
    const rows = [
      member('u_tom', 'Tom', 'neighbour', 1),
      member('u_david', 'David', 'family', 30),
      member('u_anna', 'Anna', 'family', 20),
      member('u_sarah', 'Sarah', 'organiser', 40),
    ];
    const order = reachOrder(rows.map((row) => ({ userId: row.sk.S.slice(4), name: row.name.S, role: row.role.S as CircleRole, since: Number(row.requestedAt.N) })));
    for (let drop = 0; drop < order.length; drop += 1) {
      const left = rows.filter((row) => !order.slice(0, drop).some((gone) => row.sk.S === `MEM#${gone.userId}`));
      expect(firstToAsk(left)).toEqual(order[drop]);
    }
  });
});

describe('who would be asked first', () => {
  it('is nobody she has not allowed, and nobody when her circle is empty', () => {
    expect(firstToAsk([member('u_sarah', 'Sarah', 'organiser', 1, 'pending'), member('u_dan', 'Dan', 'family', 2, 'removed')])).toBeUndefined();
    expect(firstToAsk([])).toBeUndefined();
  });

  it('skips rows that are not people at all', () => {
    expect(firstToAsk([{ pk: { S: 'HH#hh-1' }, sk: { S: 'LIGHT' } }, member('u_sarah', 'Sarah', 'organiser', 1)])).toMatchObject({ userId: 'u_sarah' });
  });
});

describe('the hold', () => {
  it('is the one event that asks for the card', () => {
    expect(isReachEvent({ t: 'reach', at: NOW })).toBe(true);
    expect(isReachEvent({ t: 'light', at: NOW })).toBe(false);
  });

  it('reads only the newest request', () => {
    expect(latestReach({ table: 'wick', householdId: 'hh-1' })).toEqual({
      TableName: 'wick',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': { S: 'HH#hh-1' }, ':prefix': { S: 'REACH#' } },
      ScanIndexForward: false,
      Limit: 1,
      ConsistentRead: true,
    });
  });
});

describe('a request already under way', () => {
  it('is shown again rather than started again', () => {
    expect(reachUnderWayId(reachRow(NOW - 60_000), NOW)).toBe(String(NOW - 60_000));
    expect(storedCardKey('hh-1', String(NOW - 60_000))).toEqual({ pk: { S: 'HH#hh-1' }, sk: { S: `CARD#${reachCardId(String(NOW - 60_000))}` } });
  });

  it('is over once answered, once everyone was asked in vain, or after long enough', () => {
    expect(reachUnderWayId(reachRow(NOW - 60_000, { answeredAt: { N: String(NOW - 1) } }), NOW)).toBeUndefined();
    expect(reachUnderWayId(reachRow(NOW - 60_000, { doneAt: { N: String(NOW - 1) } }), NOW)).toBeUndefined();
    expect(reachUnderWayId(reachRow(NOW - REACH_UNDER_WAY_MS), NOW)).toBeUndefined();
  });

  it('is over at once when it was a hello: nobody else will be asked, and she may want to be rung now', () => {
    expect(reachUnderWayId(reachRow(NOW - 60_000, { kind: { S: 'hello' } }), NOW)).toBeUndefined();
    expect(reachUnderWayId(reachRow(NOW - 60_000, { kind: { S: 'ring' } }), NOW)).toBe(String(NOW - 60_000));
  });

  it('is nothing when there has never been one, or the row is not a request', () => {
    expect(reachUnderWayId(undefined, NOW)).toBeUndefined();
    expect(reachUnderWayId({ pk: { S: 'HH#hh-1' }, sk: { S: 'REACH#x' } }, NOW)).toBeUndefined();
  });
});

describe('her press on the card', () => {
  it('goes to the agent plane when it asks for something, and leaves the card up for what comes back', () => {
    for (const action of [REACH_ACTIONS.ring, REACH_ACTIONS.hello]) {
      expect(shouldPublish(action)).toBe(true);
      expect(retiresCard(action)).toBe(false);
      expect(announcesRetirement(action)).toBe(false);
    }
  });

  it('stays in the house when it is the way out', () => {
    expect(shouldPublish(REACH_ACTIONS.notNow)).toBe(false);
    expect(retiresCard(REACH_ACTIONS.notNow)).toBe(true);
  });
});
