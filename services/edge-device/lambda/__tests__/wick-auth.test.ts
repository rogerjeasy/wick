import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_KEY_PREFIX } from '@wick/contracts';
import { hashToken } from '../../../mcp-server/src/accounts/tokens.js';
import {
  accessTokenKey,
  bearerToken,
  grantFromItem,
  mayConnectTelevision,
  membershipKey,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../wick-auth.mjs';

const NOW = 1_790_000_000_000;

describe('bearerToken', () => {
  it('reads the token from the Authorization header API Gateway hands over', () => {
    expect(bearerToken({ authorization: 'Bearer abc.def' })).toBe('abc.def');
    expect(bearerToken({ Authorization: 'bearer abc' })).toBe('abc');
  });

  it('is undefined for no header, or one that is not a bearer token', () => {
    expect(bearerToken({})).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken({ authorization: 'Basic abc' })).toBeUndefined();
    expect(bearerToken({ authorization: 'Bearer ' })).toBeUndefined();
  });
});

describe('accessTokenKey — the wire contract with the family server', () => {
  it('finds the grant where services/mcp-server stored it: by the SHA-256 of the token, never the token', () => {
    const token = 'a-token-the-family-app-holds';

    expect(accessTokenKey(token)).toEqual({
      pk: { S: `${ACCESS_TOKEN_KEY_PREFIX}${hashToken(token)}` },
      sk: { S: 'META' },
    });
    expect(JSON.stringify(accessTokenKey(token))).not.toContain(token);
  });
});

describe('grantFromItem', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    data: { S: JSON.stringify({ userId: 'u_sarah', householdId: 'hh_1', clientId: 'c', scopes: [] }) },
    expiresAt: { N: String(NOW + 1000) },
    ...over,
  });

  it('says who the token is for and which household', () => {
    expect(grantFromItem(item(), NOW)).toEqual({ userId: 'u_sarah', householdId: 'hh_1' });
  });

  it('refuses a token past its expiry, even though DynamoDB has not deleted it yet', () => {
    expect(grantFromItem(item({ expiresAt: { N: String(NOW) } }), NOW)).toBeUndefined();
  });

  it('refuses a missing item, or one that names nobody', () => {
    expect(grantFromItem(undefined, NOW)).toBeUndefined();
    expect(grantFromItem({ data: { S: '{}' }, expiresAt: { N: String(NOW + 1) } }, NOW)).toBeUndefined();
    expect(grantFromItem({ data: { S: 'not json' } }, NOW)).toBeUndefined();
  });
});

describe('mayConnectTelevision', () => {
  const member = (role: string, status: string) => ({ role: { S: role }, status: { S: status } });

  it('lets the organiser connect the television, even before the resident has allowed them — the card needs a screen', () => {
    expect(mayConnectTelevision(member('organiser', 'pending'))).toBe(true);
    expect(mayConnectTelevision(member('organiser', 'allowed'))).toBe(true);
  });

  it('refuses everyone else', () => {
    expect(mayConnectTelevision(member('family', 'allowed'))).toBe(false);
    expect(mayConnectTelevision(member('organiser', 'declined'))).toBe(false);
    expect(mayConnectTelevision(member('organiser', 'removed'))).toBe(false);
    expect(mayConnectTelevision(undefined)).toBe(false);
  });
});

describe('membershipKey', () => {
  it('matches where the family server keeps a membership', () => {
    expect(membershipKey('hh_1', 'u_sarah')).toEqual({ pk: { S: 'HH#hh_1' }, sk: { S: 'MEM#u_sarah' } });
  });
});
