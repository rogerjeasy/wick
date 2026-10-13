import { describe, expect, it } from 'vitest';
import { LIGHT_ACTIONS as CONTRACT_ACTIONS, LIGHT_CARD_ID as CONTRACT_CARD_ID, LIGHT_SK as CONTRACT_SK, LOOKIN_SK_PREFIX as CONTRACT_LOOKIN, endOfLocalDay as contractEndOfLocalDay, lookedInWords as contractLookedInWords, readHomeState, sameLocalDay as contractSameLocalDay } from '@wick/contracts';
import {
  LIGHT_ACTIONS,
  LIGHT_CARD_ID,
  LIGHT_SK,
  LOOKIN_SK_PREFIX,
  buildHomeChangedEntry,
  buildLightCard,
  endOfLocalDay,
  homeRange,
  homeState,
  lightPress,
  lightUpdate,
  lookedInWords,
  sameLocalDay,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../light.mjs';

const LONDON = 'Europe/London';
/** Monday 12 October 2026, 10:30 in London (BST). */
const NOW = Date.UTC(2026, 9, 12, 9, 30);
const HOUR = 3_600_000;

const member = (userId: string, name: string, status = 'allowed') => ({ pk: { S: 'HH#margaret' }, sk: { S: `MEM#${userId}` }, name: { S: name }, status: { S: status } });
const look = (userId: string, name: string, at: number) => ({ pk: { S: 'HH#margaret' }, sk: { S: `LOOKIN#${userId}` }, name: { S: name }, lookedAt: { N: String(at) } });
const light = (outAt?: number) => ({ pk: { S: 'HH#margaret' }, sk: { S: 'LIGHT' }, ...(outAt === undefined ? {} : { outAt: { N: String(outAt) } }) });
const meta = (exclusions: string[] = []) => ({ pk: { S: 'HH#margaret' }, sk: { S: 'META' }, ...(exclusions.length ? { residentExclusions: { SS: exclusions } } : {}) });

const state = (items: object[], now = NOW) => homeState({ items, now, timeZone: LONDON });

describe('held to the contract', () => {
  it('uses the same rows, the same card and the same buttons as the family’s side', () => {
    expect(LIGHT_SK).toBe(CONTRACT_SK);
    expect(LOOKIN_SK_PREFIX).toBe(CONTRACT_LOOKIN);
    expect(LIGHT_CARD_ID).toBe(CONTRACT_CARD_ID);
    expect(LIGHT_ACTIONS).toEqual(CONTRACT_ACTIONS);
  });

  it('means the same day by "today"', () => {
    for (const [a, b] of [[NOW, NOW + 13 * HOUR], [NOW, NOW + 15 * HOUR], [NOW - 11 * HOUR, NOW]] as const) {
      expect(sameLocalDay(a, b, LONDON)).toBe(contractSameLocalDay(a, b, LONDON));
    }
  });

  it('says who looked in with the very words the family’s side uses', () => {
    for (const hour of [7, 11, 12, 16, 17, 20]) {
      const at = Date.UTC(2026, 9, 12, hour, 30);
      expect(lookedInWords('Sarah', at, LONDON)).toBe(contractLookedInWords('Sarah', at, LONDON));
    }
  });

  it('reads everything the home screen needs in one range of the household’s rows', () => {
    expect(homeRange({ table: 'wick', householdId: 'margaret' })).toEqual({
      TableName: 'wick',
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':pk': { S: 'HH#margaret' }, ':from': { S: 'LIGHT' }, ':to': { S: 'META' } },
    });
  });
});

describe('homeState — what her home screen is told', () => {
  it('says her light is on when somebody she allowed can see it', () => {
    expect(state([meta(), member('u1', 'Sarah Hughes')])).toEqual({ light: 'on' });
  });

  it('says it is out for the day she put it out, and on again the next', () => {
    const items = [meta(), member('u1', 'Sarah'), light(NOW - HOUR)];

    // Out, and until when: a television left on overnight must not go on saying so tomorrow.
    expect(state(items)).toEqual({ light: 'out', lightOutUntil: Date.UTC(2026, 9, 12, 23, 0) });
    expect(state(items, NOW + 24 * HOUR)).toEqual({ light: 'on' });
  });

  it('means the same end of the day as the contract, also when the clocks change', () => {
    for (const at of [NOW, Date.UTC(2026, 9, 12, 22, 59), Date.UTC(2026, 9, 24, 23, 30), Date.UTC(2026, 9, 25, 12, 0), Date.UTC(2026, 2, 29, 0, 30)]) {
      expect(endOfLocalDay(at, LONDON)).toBe(contractEndOfLocalDay(at, LONDON));
    }
  });

  it('has no light at all when nobody can see one: nobody allowed yet, or the week kept private', () => {
    expect(state([meta()])).toEqual({});
    expect(state([meta(), member('u1', 'Sarah', 'pending')])).toEqual({});
    expect(state([meta(['RHYTHM']), member('u1', 'Sarah')])).toEqual({});
  });

  it('says who looked in today, the latest of them, by first name', () => {
    const items = [meta(), member('u1', 'Sarah Hughes'), member('u2', 'Tom'), look('u1', 'Sarah Hughes', NOW - 2 * HOUR), look('u2', 'Tom', NOW - 26 * HOUR)];

    // The sentence, and until when it holds: midnight where the house is, whatever the television's own clock says.
    expect(state(items)).toEqual({
      light: 'on',
      lookedIn: { name: 'Sarah', at: NOW - 2 * HOUR, line: 'Sarah looked in this morning.', until: Date.UTC(2026, 9, 12, 23, 0) },
    });
  });

  it('says nothing of a look from somebody she has since removed', () => {
    expect(state([meta(), member('u1', 'Sarah'), look('u9', 'Gone', NOW - HOUR)])).toEqual({ light: 'on' });
  });

  it('ignores the other rows that sit in the same range', () => {
    const doorLook = { pk: { S: 'HH#margaret' }, sk: { S: 'LOOK#door-1' }, name: { S: 'x' }, lookedAt: { N: String(NOW) } };

    expect(state([meta(), member('u1', 'Sarah'), doorLook])).toEqual({ light: 'on' });
  });
});

describe('buildHomeChangedEntry — telling the home’s other televisions', () => {
  const home = { light: 'out', lightOutUntil: Date.UTC(2026, 9, 12, 23, 0), lookedIn: { name: 'Sarah', at: NOW - HOUR, line: 'Sarah looked in this morning.' } };
  const entry = buildHomeChangedEntry({ busName: 'wick-bus', householdId: 'margaret', deviceId: 'wick-tv', home, at: NOW });

  it('says which home, which television was pressed, and how the home screen now stands', () => {
    expect(entry).toMatchObject({ EventBusName: 'wick-bus', Source: 'wick.device', DetailType: 'home.changed' });
    expect(JSON.parse(entry.Detail)).toEqual({ householdId: 'margaret', deviceId: 'wick-tv', home, at: NOW });
  });

  it('carries a state the agent plane can read as it stands', () => {
    expect(readHomeState(JSON.parse(entry.Detail).home)).toEqual(home);
  });
});

describe('buildLightCard — her own light, in words', () => {
  const card = (items: object[]) => buildLightCard({ householdId: 'margaret', items, now: NOW, timeZone: LONDON });

  it('says who can see it, how little it says, and who looked in', () => {
    const queued = card([meta(), member('u1', 'Sarah Hughes'), look('u1', 'Sarah Hughes', NOW - 2 * HOUR)]);

    expect(queued).toMatchObject({ id: 'light', urgency: 'DEFERRED', shownCount: 0 });
    expect(queued.card).toMatchObject({
      type: 'LIGHT',
      id: 'light',
      householdId: 'margaret',
      headline: 'Your light is on.',
      detail: 'Sarah can see that your day has begun, and nothing more: not when, and not what you watch. Sarah looked in this morning.',
      actions: [
        { id: 'ok', label: 'Leave it on', kind: 'primary' },
        { id: 'put_out', label: 'Put it out for today', kind: 'secondary' },
      ],
    });
  });

  it('speaks of the family when more than one person can see it', () => {
    const queued = card([meta(), member('u1', 'Sarah'), member('u2', 'Tom')]);

    expect(queued.card.detail).toBe('Your family can see that your day has begun, and nothing more: not when, and not what you watch.');
  });

  it('says so when it is out, and that nobody can tell why', () => {
    const queued = card([meta(), member('u1', 'Sarah'), light(NOW - HOUR), look('u1', 'Sarah', NOW - 30 * 60_000)]);

    expect(queued.card).toMatchObject({
      headline: 'Your light is out for today.',
      detail: 'Sarah cannot tell whether you put it out or it has not been lit yet. It lights again tomorrow. Sarah looked in this morning.',
      actions: [
        { id: 'ok', label: 'Leave it out', kind: 'primary' },
        { id: 'light_again', label: 'Light it again', kind: 'secondary' },
      ],
    });
  });

  it('names the part of the day somebody looked in', () => {
    const at = (hour: number) => Date.UTC(2026, 9, 12, hour - 1, 0); // London is UTC+1
    const said = (lookAt: number, now: number) =>
      buildLightCard({ householdId: 'margaret', items: [meta(), member('u1', 'Sarah'), look('u1', 'Sarah', lookAt)], now, timeZone: LONDON }).card.detail;

    expect(said(at(14), at(15))).toContain('Sarah looked in this afternoon.');
    expect(said(at(19), at(20))).toContain('Sarah looked in this evening.');
  });

  it('is no card when there is no light to show', () => {
    expect(card([meta()])).toBeUndefined();
    expect(card([meta(['RHYTHM']), member('u1', 'Sarah')])).toBeUndefined();
  });
});

describe('lightPress and lightUpdate — the one thing her television can change', () => {
  it('knows the two presses that change the light, and that "leave it" changes nothing', () => {
    expect(lightPress('light', 'put_out')).toBe('put_out');
    expect(lightPress('light', 'light_again')).toBe('light_again');
    expect(lightPress('light', 'ok')).toBeUndefined();
    expect(lightPress('note-1', 'put_out')).toBeUndefined();
  });

  it('puts it out by the server’s clock, and lights it again by taking that away', () => {
    expect(lightUpdate({ table: 'wick', householdId: 'margaret', press: 'put_out', at: NOW })).toEqual({
      TableName: 'wick',
      Key: { pk: { S: 'HH#margaret' }, sk: { S: 'LIGHT' } },
      UpdateExpression: 'SET outAt = :at',
      ExpressionAttributeValues: { ':at': { N: String(NOW) } },
    });
    expect(lightUpdate({ table: 'wick', householdId: 'margaret', press: 'light_again', at: NOW })).toEqual({
      TableName: 'wick',
      Key: { pk: { S: 'HH#margaret' }, sk: { S: 'LIGHT' } },
      UpdateExpression: 'REMOVE outAt',
    });
  });
});
