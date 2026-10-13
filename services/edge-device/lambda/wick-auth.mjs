/**
 * Who is asking to connect a television.
 *
 * A family member's app holds an access token from the Wick MCP server
 * (services/mcp-server/src/accounts/oauthProvider.ts). That server keeps
 * each token's grant in this same table, keyed by the SHA-256 of the token
 * — never the token — so this Lambda can check one with a single GetItem,
 * without a shared secret and without calling the server.
 *
 * INV-8: the household a television is connected to is the one in the
 * caller's grant. It is never read from the request.
 *
 * This plain .mjs Lambda can't import TS, so the two facts it shares with
 * the server are inlined, each with a pointer to its source — keep them in
 * step (wick-auth.test.ts holds them to it):
 *   - ACCESS_TOKEN_KEY_PREFIX   packages/contracts/src/circle.ts
 *   - the hash                  services/mcp-server/src/accounts/tokens.ts hashToken
 *
 * Pure: pair-claim.mjs owns the DynamoDB client.
 */
import { createHash } from 'node:crypto';

const ACCESS_TOKEN_KEY_PREFIX = 'OAUTH#AT#';

/** The bearer token in an API Gateway v2 event's headers, if there is one. */
export function bearerToken(headers) {
  const value = headers?.authorization ?? headers?.Authorization;
  if (typeof value !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return match ? match[1] : undefined;
}

/** Where the grant for this token is stored. */
export function accessTokenKey(token) {
  const hash = createHash('sha256').update(token).digest('hex');
  return { pk: { S: `${ACCESS_TOKEN_KEY_PREFIX}${hash}` }, sk: { S: 'META' } };
}

/**
 * The person and household a stored grant names — or undefined when there
 * is none, or it is past its expiry. DynamoDB's own TTL deletes late, so the
 * expiry is always checked here.
 */
export function grantFromItem(item, now) {
  const raw = item?.data?.S;
  if (!raw) return undefined;
  const expiresAt = item.expiresAt?.N;
  if (expiresAt !== undefined && Number(expiresAt) <= now) return undefined;
  let grant;
  try {
    grant = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof grant?.userId !== 'string' || typeof grant?.householdId !== 'string') return undefined;
  return { userId: grant.userId, householdId: grant.householdId };
}

/** Where the family server keeps a membership (services/mcp-server/src/accounts/store.ts). */
export function membershipKey(householdId, userId) {
  return { pk: { S: `HH#${householdId}` }, sk: { S: `MEM#${userId}` } };
}

/**
 * The organiser connects the television — and may do so while still
 * waiting for the resident, because the card that asks the resident needs
 * a television to appear on.
 */
export function mayConnectTelevision(memberItem) {
  const status = memberItem?.status?.S;
  return memberItem?.role?.S === 'organiser' && (status === 'pending' || status === 'allowed');
}

/**
 * A television of a family member's own — "Sarah's television"
 * (family-television.mjs). Only somebody the resident has already allowed
 * (INV-9: it shows what that person may read, so not while they wait), and
 * not a neighbour, who is asked things and shown nothing.
 */
export function mayConnectOwnTelevision(memberItem) {
  const role = memberItem?.role?.S;
  return memberItem?.status?.S === 'allowed' && (role === 'organiser' || role === 'family');
}
