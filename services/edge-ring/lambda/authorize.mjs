/**
 * Starts the partner-initiated OAuth flow (Ring Partner API).
 *
 * Ring supports two linking models. The one-way, Ring-driven flow POSTs an
 * authorization code to the Token Exchange URL and redirects the browser with a
 * nonce — but for a private app the console's "Connect Ring account" button
 * completes its own authorisation without ever calling our endpoints, so that
 * flow never fires. Partner-initiated is the one we can actually drive.
 *
 *   GET /ring/authorize
 *     -> 302 https://account.ring.com/account/integrations/partner-link/authorize
 *
 * PKCE (S256) is mandatory. The verifier is held in DynamoDB under the state
 * value with a 10-minute TTL — the authorization code expires in 10 minutes, so
 * there is no reason to keep the verifier longer.
 */
import { randomBytes, createHash } from 'node:crypto';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const ddb = new DynamoDBClient({});
const sm = new SecretsManagerClient({});

const TABLE = process.env.TABLE_NAME;
const SECRET_ARN = process.env.RING_SECRET_ARN;
const REDIRECT_URI = process.env.RING_REDIRECT_URI;
const AUTHORIZE_URL = 'https://account.ring.com/account/integrations/partner-link/authorize';
const SCOPE = process.env.RING_SCOPE ?? 'ava.v1:read';

const b64url = (buf) => buf.toString('base64url');

let cachedClientId = null;
async function clientId() {
  if (cachedClientId) return cachedClientId;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  cachedClientId = JSON.parse(r.SecretString).clientId;
  return cachedClientId;
}

export const handler = async () => {
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `OAUTH#${state}` },
      sk: { S: 'META' },
      codeVerifier: { S: verifier },
      createdAt: { N: String(Date.now()) },
      ttl: { N: String(Math.floor(Date.now() / 1000) + 600) },
    },
  }));

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', await clientId());
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  console.log(JSON.stringify({
    level: 'info',
    msg: 'authorize_redirect_issued',
    redirectUri: REDIRECT_URI,
    scope: SCOPE,
    // The state is a CSRF token, not a bearer credential, but there is no reason
    // to print it in full.
    statePrefix: state.slice(0, 8),
  }));

  return {
    statusCode: 302,
    headers: { Location: url.toString(), 'Cache-Control': 'no-store' },
    body: '',
  };
};
