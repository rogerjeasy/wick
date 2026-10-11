/**
 * The start of a Ring sign-in: a state value that remembers who is linking,
 * and the address at Ring to send their browser to.
 *
 * PKCE (S256) is mandatory. The verifier is held in DynamoDB under the state
 * value with a 10-minute TTL — the authorization code expires in 10 minutes,
 * so there is no reason to keep the verifier longer.
 *
 * The state row is where the household comes from when Ring sends the
 * browser back (link.mjs): it was written here, for a household the family
 * app's server took from the organiser's access token. Nothing in the
 * callback's own address can name a household (AGENTS.md INV-8).
 *
 * Coming back from Ring does not finish a household's link. Anyone can be
 * sent Ring's sign-in address: an organiser could start a link for their own
 * home, pass the address to someone else, and — if the callback alone
 * finished it — have that person's doorbells linked to the organiser's home.
 * So the callback keeps Ring's code under a one-time completion value and
 * hands that value to the browser that signed in; the link is made only when
 * the family app presents it back as the same organiser, for the same home,
 * that started it (household-link-service.mjs `complete`). The person who
 * started it never sees the value; the person who signed in is not that
 * organiser. Neither can finish it alone.
 */
import { randomBytes, createHash } from 'node:crypto';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { readCredentials } from './ring-token.mjs';

const ddb = new DynamoDBClient({});

const TABLE = process.env.TABLE_NAME;
const REDIRECT_URI = process.env.RING_REDIRECT_URI;
const AUTHORIZE_URL = 'https://account.ring.com/account/integrations/partner-link/authorize';
const SCOPE = process.env.RING_SCOPE ?? 'ava.v1:read';
const STATE_TTL_S = 600;

/** A completion value as this module makes them. Anything else is not one. */
export const COMPLETION_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

const b64url = (buf) => buf.toString('base64url');

/** The state row for one sign-in. Pure, so what it binds is tested. */
export function stateRow({ table, state, verifier, householdId, userId, now }) {
  return {
    TableName: table,
    Item: {
      pk: { S: `OAUTH#${state}` },
      sk: { S: 'META' },
      codeVerifier: { S: verifier },
      householdId: { S: householdId },
      ...(userId ? { userId: { S: userId } } : {}),
      createdAt: { N: String(now) },
      ttl: { N: String(Math.floor(now / 1000) + STATE_TTL_S) },
    },
  };
}

/**
 * Whether a state or completion row is still inside its ten minutes. The
 * table's TTL removes old rows eventually, not on time, so the age is
 * checked here and an old row is treated as no row.
 */
export function isFresh(item, now) {
  const createdAt = Number(item?.createdAt?.N);
  return Number.isFinite(createdAt) && now - createdAt < STATE_TTL_S * 1000 && now >= createdAt - 60_000;
}

export const stateKey = (state) => ({ pk: { S: `OAUTH#${state}` }, sk: { S: 'META' } });

/** Kept under the value's hash, so the table never holds something that could be presented. */
export const completionKey = (completion) => ({
  pk: { S: `OAUTHDONE#${createHash('sha256').update(String(completion)).digest('hex')}` },
  sk: { S: 'META' },
});

/** A fresh completion value: 256 bits, for one browser, once. */
export const newCompletion = () => b64url(randomBytes(32));

/**
 * What the callback keeps until the family app finishes the link: which
 * sign-in this was, and Ring's code for it. The code is single-use, expires
 * in ten minutes, and is worthless without the client secret and the PKCE
 * verifier, both of which stay on the server.
 */
export function completionRow({ table, completion, state, code, now }) {
  return {
    TableName: table,
    Item: {
      ...completionKey(completion),
      state: { S: state },
      code: { S: code },
      createdAt: { N: String(now) },
      ttl: { N: String(Math.floor(now / 1000) + STATE_TTL_S) },
    },
  };
}

/**
 * What to do with a browser Ring has sent back. Pure.
 *
 *   'finish_in_app'  a household started this: hand the browser a completion
 *                    value, and let the family app finish it as the organiser
 *   'operator'       nobody's household is named: the deployment's own link,
 *                    and only where the deployment allows that address at all
 *   'refuse'         no such sign-in, or one this deployment does not take
 */
export function callbackPlan(stateItem, { operatorLinkAllowed, now = Date.now() }) {
  if (!stateItem?.codeVerifier?.S || !isFresh(stateItem, now)) return 'refuse';
  if (stateItem.householdId?.S && stateItem.userId?.S) return 'finish_in_app';
  return operatorLinkAllowed ? 'operator' : 'refuse';
}

/** Ring's sign-in address for a state and its challenge. Pure. */
export function authorizeUrl({ clientId, redirectUri, scope, state, challenge }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Remember who is linking, and return where to send their browser. */
export async function beginAuthorization({ householdId, userId }) {
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  await ddb.send(new PutItemCommand(stateRow({ table: TABLE, state, verifier, householdId, userId, now: Date.now() })));

  console.log(JSON.stringify({
    level: 'info',
    msg: 'authorize_redirect_issued',
    householdId,
    redirectUri: REDIRECT_URI,
    scope: SCOPE,
    // The state is a CSRF token, not a bearer credential, but there is no reason
    // to print it in full.
    statePrefix: state.slice(0, 8),
  }));

  const { clientId } = await readCredentials();
  return authorizeUrl({ clientId, redirectUri: REDIRECT_URI, scope: SCOPE, state, challenge });
}
