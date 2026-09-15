/**
 * Account Link URL — and the OAuth callback.
 *
 * This one endpoint serves both of Ring's linking models, because it is the URL
 * registered in the console and the redirect_uri must match a pre-registered one
 * exactly. It branches on the parameters present:
 *
 *   ?code=&state=      partner-initiated callback -> exchange for tokens
 *   ?nonce=&timestamp= one-way Ring-driven redirect -> claim the unclaimed token
 *   (neither)          a human arriving directly -> show the consent page
 *
 * THE NONCE IS A CREDENTIAL. Matching it against an unclaimed token is what
 * completes a link, so values are never logged in plaintext — only names, lengths
 * and truncated hashes, which is enough to correlate without being usable.
 */
import { createHash } from 'node:crypto';
import { DynamoDBClient, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand }
  from '@aws-sdk/client-secrets-manager';

const ddb = new DynamoDBClient({});
const sm = new SecretsManagerClient({});

const TABLE = process.env.TABLE_NAME;
const SECRET_ARN = process.env.RING_SECRET_ARN;
const TOKEN_SECRET_ARN = process.env.RING_TOKEN_SECRET_ARN;
const REDIRECT_URI = process.env.RING_REDIRECT_URI;
const CONSENT_PAGE =
  process.env.CONSENT_PAGE_URL ?? 'https://rogerjeasy.github.io/wick/link.html';
const TOKEN_URL = 'https://oauth.ring.com/oauth/token';

const fingerprint = (v) =>
  createHash('sha256').update(String(v)).digest('hex').slice(0, 12);

const describe = (params) =>
  Object.fromEntries(
    Object.entries(params ?? {}).map(([k, v]) => [
      k, { len: String(v).length, sha256_12: fingerprint(v) },
    ]),
  );

const page = (title, body, ok = true) => ({
  statusCode: ok ? 200 : 400,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wick — ${title}</title>
<style>body{margin:0;background:#12100E;color:#F4F1EA;font:17px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:30rem;padding:2rem;text-align:center}h1{font-family:Georgia,serif;font-size:1.9rem;margin:0 0 .75rem}
p{color:#C8C2B6}a{color:#E8B75D}</style>
<main><h1>${title}</h1><p>${body}</p><p><a href="https://rogerjeasy.github.io/wick/">Wick</a></p></main>`,
});

export const handler = async (event) => {
  const p = event.queryStringParameters ?? {};

  console.log(JSON.stringify({
    level: 'info',
    msg: 'account_link_received',
    paramKeys: Object.keys(p),
    params: describe(p),
    userAgent: event.requestContext?.http?.userAgent ?? null,
  }));

  // --- partner-initiated callback -----------------------------------------
  if (p.code && p.state) {
    const row = await ddb.send(new GetItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `OAUTH#${p.state}` }, sk: { S: 'META' } },
    }));

    // An unknown state is either CSRF or an expired attempt. Refuse either way.
    if (!row.Item?.codeVerifier?.S) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'unknown_or_expired_state' }));
      return page('Link expired', 'That link has expired or was already used. Start again from the beginning.', false);
    }

    const creds = JSON.parse(
      (await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }))).SecretString,
    );

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: p.code,
        code_verifier: row.Item.codeVerifier.S,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: REDIRECT_URI,
      }),
    });

    // Single-use state: consume it whether or not the exchange succeeded.
    await ddb.send(new DeleteItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `OAUTH#${p.state}` }, sk: { S: 'META' } },
    }));

    if (!res.ok) {
      const detail = await res.text();
      console.error(JSON.stringify({
        level: 'error', msg: 'token_exchange_failed',
        status: res.status, detail: detail.slice(0, 400),
      }));
      return page('Could not connect', `Ring declined the exchange (HTTP ${res.status}).`, false);
    }

    const tokens = await res.json();
    await sm.send(new PutSecretValueCommand({
      SecretId: TOKEN_SECRET_ARN,
      SecretString: JSON.stringify({ ...tokens, obtainedAt: Date.now() }),
    }));

    console.log(JSON.stringify({
      level: 'info', msg: 'account_linked',
      expiresIn: tokens.expires_in ?? null,
      hasRefresh: Boolean(tokens.refresh_token),
    }));
    return page('Connected', 'Wick can now see your Ring doorbell events. You can close this window.');
  }

  if (p.error) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'authorize_declined', error: p.error }));
    return page('Not connected', 'The request was declined at Ring. Nothing has changed.', false);
  }

  // --- one-way Ring-driven redirect, or a human arriving directly ----------
  // The nonce claim is not implemented: for a private app the console completes
  // its own authorisation and this path has never fired. Logged so that if it
  // ever does, the parameter shape is on record.
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
  return {
    statusCode: 302,
    headers: { Location: `${CONSENT_PAGE}${qs}`, 'Cache-Control': 'no-store' },
    body: '',
  };
};
