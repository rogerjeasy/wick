import { describe, expect, it } from 'vitest';
import {
  FAMILY_TV_CARD_KINDS,
  FAMILY_TV_KIND,
  FAMILY_TV_OWN_ACTIONS,
  FAMILY_TV_PRESSES,
  FAMILY_TV_SEAT_EVERY_MS,
  FAMILY_TV_SERVICE_SESSION_MS,
  FAMILY_TV_SK_PREFIX,
  FAMILY_TV_WAITING_EVERY_MS,
  FAMILY_TV_WAITING_SCOPE,
  FAMILY_TV_WAVE_CARD,
  isFamilyTvOwnAction,
  isFamilyTvQuietPress,
  MAX_CARD_ACTIONS,
  PAIRING_PUBLIC_KEY_ROW,
  familyTvCardId,
  isFamilyTelevisionToken,
  parseFamilyTvCardId,
} from '../index.js';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { FAMILY_KIND, FAMILY_TV_SK_PREFIX as EDGE_PREFIX, PAIRING_PUBLIC_KEY, SERVICE_SESSION_MAX_MS } from '../../../../services/edge-device/lambda/family-television.mjs';

describe('a family television, named the same at the edge and everywhere else', () => {
  it('has one kind, one row prefix and one place for the key its token is checked with', () => {
    expect(FAMILY_KIND).toBe(FAMILY_TV_KIND);
    expect(EDGE_PREFIX).toBe(FAMILY_TV_SK_PREFIX);
    expect(PAIRING_PUBLIC_KEY).toEqual({ pk: { S: PAIRING_PUBLIC_KEY_ROW.pk }, sk: { S: PAIRING_PUBLIC_KEY_ROW.sk } });
  });

  it('bounds a background service’s session by the same seven days at the edge, which mints its tokens, and at the Wick server, which takes them', () => {
    expect(FAMILY_TV_SERVICE_SESSION_MS).toBe(7 * 24 * 60 * 60_000);
    // The edge's own bound, exported from family-television.mjs as SERVICE_SESSION_MAX_MS.
    expect(SERVICE_SESSION_MAX_MS).toBe(FAMILY_TV_SERVICE_SESSION_MS);
  });
});

describe('telling a family television’s token from the resident’s', () => {
  it('is by the kind it was given at pairing, with the member it belongs to', () => {
    expect(isFamilyTelevisionToken({ deviceId: 'tv-2', householdId: 'hh_1', kind: 'family', userId: 'u_sarah' })).toBe(true);
  });

  it('is a family television’s still when it is the narrower token its background service holds', () => {
    expect(FAMILY_TV_WAITING_SCOPE).toBe('waiting');
    expect(isFamilyTelevisionToken({ deviceId: 'tv-2', householdId: 'hh_1', kind: 'family', userId: 'u_sarah', scope: FAMILY_TV_WAITING_SCOPE })).toBe(true);
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
    for (const id of ['reach-1791890720386', 'ftv-film-1', 'ftv-reach-', 'ftv-reach-a#b', 'ftv-', 7, undefined]) {
      expect(parseFamilyTvCardId(id)).toBeUndefined();
    }
  });

  it('comes in the kinds a family television is for, and never more buttons than any card', () => {
    expect(FAMILY_TV_CARD_KINDS).toEqual(['door_look', 'reach', 'watch', 'wave', 'week']);
    expect(MAX_CARD_ACTIONS).toBe(3);
  });
});

describe('the later things a family television is for', () => {
  it('names a week by its ISO week, a film by its session, and a wave by its own id', () => {
    expect(parseFamilyTvCardId(familyTvCardId('week', '2026-W41'))).toEqual({ kind: 'week', requestId: '2026-W41' });
    expect(parseFamilyTvCardId(familyTvCardId('watch', 'w_8Jk2-x'))).toEqual({ kind: 'watch', requestId: 'w_8Jk2-x' });
    expect(parseFamilyTvCardId(familyTvCardId('wave', '1791890720386'))).toEqual({ kind: 'wave', requestId: '1791890720386' });
  });

  it('has one card to press for a new wave, which is no wave that was ever sent', () => {
    expect(FAMILY_TV_WAVE_CARD).toBe('ftv-wave-new');
    expect(parseFamilyTvCardId(FAMILY_TV_WAVE_CARD)).toEqual({ kind: 'wave', requestId: 'new' });
  });

  it('keeps apart the buttons the television answers itself: they are never sent', () => {
    expect(FAMILY_TV_OWN_ACTIONS).toEqual({ read: 'ftv-read', later: 'ftv-later', seat: 'ftv-seat' });
    for (const id of Object.values(FAMILY_TV_OWN_ACTIONS)) expect(isFamilyTvOwnAction(id)).toBe(true);
    for (const id of ['now', 'known', 'sit', 'wave', 'read', '', undefined, 7]) expect(isFamilyTvOwnAction(id)).toBe(false);
    // No answer anybody can give is spelled like one of them.
    for (const press of Object.values(FAMILY_TV_PRESSES)) expect(isFamilyTvOwnAction(press)).toBe(false);
  });

  it('knows the presses whose answer is not shown: having read the week, having seen a wave come back', () => {
    expect(FAMILY_TV_PRESSES).toEqual({ sit: 'sit', wave: 'wave', read: 'read', seen: 'seen' });
    expect(isFamilyTvQuietPress('read')).toBe(true);
    expect(isFamilyTvQuietPress('seen')).toBe(true);
    for (const press of ['sit', 'wave', 'now', 'ftv-read', undefined]) expect(isFamilyTvQuietPress(press)).toBe(false);
  });

  it('follows a film closely and asks what is waiting seldom', () => {
    expect(FAMILY_TV_SEAT_EVERY_MS).toBe(2_000);
    expect(FAMILY_TV_WAITING_EVERY_MS).toBe(20_000);
  });
});

