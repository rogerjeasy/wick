import { describe, expect, it } from 'vitest';
import {
  FAMILY_TV_CARD_KINDS,
  FAMILY_TV_KIND,
  FAMILY_TV_SK_PREFIX,
  MAX_CARD_ACTIONS,
  PAIRING_PUBLIC_KEY_ROW,
  familyTvCardId,
  isFamilyTelevisionToken,
  parseFamilyTvCardId,
} from '../index.js';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { FAMILY_KIND, FAMILY_TV_SK_PREFIX as EDGE_PREFIX, PAIRING_PUBLIC_KEY } from '../../../../services/edge-device/lambda/family-television.mjs';

describe('a family television, named the same at the edge and everywhere else', () => {
  it('has one kind, one row prefix and one place for the key its token is checked with', () => {
    expect(FAMILY_KIND).toBe(FAMILY_TV_KIND);
    expect(EDGE_PREFIX).toBe(FAMILY_TV_SK_PREFIX);
    expect(PAIRING_PUBLIC_KEY).toEqual({ pk: { S: PAIRING_PUBLIC_KEY_ROW.pk }, sk: { S: PAIRING_PUBLIC_KEY_ROW.sk } });
  });
});

describe('telling a family television’s token from the resident’s', () => {
  it('is by the kind it was given at pairing, with the member it belongs to', () => {
    expect(isFamilyTelevisionToken({ deviceId: 'tv-2', householdId: 'hh_1', kind: 'family', userId: 'u_sarah' })).toBe(true);
  });

  it('is never a token without a member, with another kind, or the resident’s own', () => {
    for (const claims of [
      { deviceId: 'tv-1', householdId: 'hh_1' },
      { deviceId: 'tv-1', householdId: 'hh_1', kind: 'family' },
      { deviceId: 'tv-1', householdId: 'hh_1', kind: 'resident', userId: 'u_sarah' },
      { householdId: 'hh_1', kind: 'family', userId: 'u_sarah' },
      { deviceId: 'tv-1', kind: 'family', userId: 'u_sarah' },
      null,
      'family',
    ]) {
      expect(isFamilyTelevisionToken(claims)).toBe(false);
    }
  });
});

describe('a card on a family television', () => {
  it('names what it is about and which request, and nothing else', () => {
    expect(familyTvCardId('reach', '1791890720386')).toBe('ftv-reach-1791890720386');
    expect(parseFamilyTvCardId('ftv-reach-1791890720386')).toEqual({ kind: 'reach', requestId: '1791890720386' });
    expect(parseFamilyTvCardId('ftv-door_look-door-abc_1')).toEqual({ kind: 'door_look', requestId: 'door-abc_1' });
  });

  it('is not read out of the resident’s cards, an unknown kind, or anything that could not be a key', () => {
    for (const id of ['reach-1791890720386', 'ftv-week-1', 'ftv-reach-', 'ftv-reach-a#b', 'ftv-', 7, undefined]) {
      expect(parseFamilyTvCardId(id)).toBeUndefined();
    }
  });

  it('comes in the kinds a family television is for, and never more buttons than any card', () => {
    expect(FAMILY_TV_CARD_KINDS).toEqual(['door_look', 'reach']);
    expect(MAX_CARD_ACTIONS).toBe(3);
  });
});
