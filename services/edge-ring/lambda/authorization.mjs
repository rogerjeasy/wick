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
