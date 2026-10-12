import { describe, expect, it } from 'vitest';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { ACTIVE_SIGNAL_EVERY_MS, buildTelevisionActiveEntry, claimActiveSignal, isActiveSignal } from '../television-active.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { shouldPublish } from '../card-action-event.mjs';

describe('isActiveSignal — when the resident is at the television', () => {
  it('is a television that has just connected, come to the front, or is being watched', () => {
    expect(isActiveSignal({ t: 'reconcile' })).toBe(true);
    expect(isActiveSignal({ t: 'app_lifecycle', state: 'fg', at: 1 })).toBe(true);
    expect(isActiveSignal({ t: 'playback', state: 'PLAYING', at: 1 })).toBe(true);
    expect(isActiveSignal({ t: 'playback', state: 'PAUSED', at: 1 })).toBe(true);
  });

  it('is not one that is leaving, stopped, or merely reporting a card', () => {
    expect(isActiveSignal({ t: 'app_lifecycle', state: 'bg', at: 1 })).toBe(false);
    expect(isActiveSignal({ t: 'playback', state: 'STOPPED', at: 1 })).toBe(false);
    expect(isActiveSignal({ t: 'card_shown', cardId: 'x', at: 1 })).toBe(false);
    expect(isActiveSignal({ t: 'card_action', cardId: 'x', action: 'dismiss', at: 1 })).toBe(false);
    expect(isActiveSignal(undefined)).toBe(false);
  });
});

describe('claimActiveSignal — one signal every little while, however much is watched', () => {
  it('stamps the television’s own row only if it has not signalled lately', () => {
    const now = 10_000_000;

    expect(claimActiveSignal({ table: 'wick', householdId: 'hh-1', deviceId: 'wick-tv', now })).toEqual({
      TableName: 'wick',
      Key: { pk: { S: 'HH#hh-1' }, sk: { S: 'DEV#wick-tv' } },
      UpdateExpression: 'SET activeSignalAt = :now',
      ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(activeSignalAt) OR activeSignalAt < :cutoff)',
      ExpressionAttributeValues: { ':now': { N: String(now) }, ':cutoff': { N: String(now - ACTIVE_SIGNAL_EVERY_MS) } },
    });
  });
});

describe('buildTelevisionActiveEntry', () => {
  it('says which household’s television is active, and nothing about what is on it', () => {
    expect(buildTelevisionActiveEntry({ busName: 'wick', householdId: 'hh-1', deviceId: 'wick-tv', at: 5 })).toEqual({
      EventBusName: 'wick',
      Source: 'wick.device',
      DetailType: 'television.active',
      Detail: JSON.stringify({ householdId: 'hh-1', deviceId: 'wick-tv', at: 5 }),
    });
  });
});

describe('shouldPublish — the resident’s answer to "Shall I tell …?"', () => {
  it('hands both answers to the agent plane, which records them and tells nobody or somebody', () => {
    expect(shouldPublish('tell_family')).toBe(true);
    expect(shouldPublish('keep_private')).toBe(true);
  });
});
