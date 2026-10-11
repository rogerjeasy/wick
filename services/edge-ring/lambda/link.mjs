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
import { DynamoDBClient, GetItemCommand, DeleteItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { readCredentials, readTokens, finishLink } from './ring-token.mjs';
import { exchangeAuthorizationCode } from './ring-api.mjs';
import { linkService } from './household-link.mjs';
import { callbackPlan, completionRow, newCompletion, stateKey } from './authorization.mjs';

const ddb = new DynamoDBClient({});

const TABLE = process.env.TABLE_NAME;
const REDIRECT_URI = process.env.RING_REDIRECT_URI;
/** The household this deployment was set up around: the only one a link with no household can belong to. */
const OPERATOR_HOUSEHOLD = process.env.WICK_HOUSEHOLD_ID;
/** Whether this deployment takes the operator's own link at all (authorize.mjs). Off unless it says so. */
const OPERATOR_LINK = process.env.RING_OPERATOR_LINK === 'true';
/** Where the family app lives: a household's sign-in is finished there, by its organiser. */
const FAMILY_APP_URL = (process.env.FAMILY_APP_URL ?? '').replace(/\/+$/, '') + '/';
const CONSENT_PAGE =
  process.env.CONSENT_PAGE_URL ?? 'https://rogerjeasy.github.io/wick/link.html';

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
    const row = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: stateKey(p.state), ConsistentRead: true }));
    const plan = callbackPlan(row.Item, { operatorLinkAllowed: OPERATOR_LINK });

    // An unknown state is either CSRF or an expired attempt. Refuse either way.
    if (plan === 'refuse') {
      console.warn(JSON.stringify({ level: 'warn', msg: 'unknown_or_expired_state' }));
      return page('Link expired', 'That link has expired or was already used. Start again from the beginning.', false);
    }

    // A household's own link is not finished here. This browser signed in at
    // Ring, but that does not make it the organiser who started the link —
    // the address could have been sent to anyone (authorization.mjs says
    // why). Ring's code is kept under a one-time value, the value goes to
    // this browser, and the family app finishes the link by presenting it as
    // the organiser it is signed in as. In the fragment, so it reaches no
    // server log and no Referer.
    if (plan === 'finish_in_app') {
      const completion = newCompletion();
      await ddb.send(new PutItemCommand(completionRow({ table: TABLE, completion, state: p.state, code: p.code, now: Date.now() })));
      return {
        statusCode: 302,
        headers: { Location: `${FAMILY_APP_URL}#ring=${completion}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
        body: '',
      };
    }

    // The operator's own link (authorize.mjs): no household started it, so it
    // is the deployment's. Only where the deployment allows that address.
    // Single-use state: consume it whether or not the exchange succeeds.
    await ddb.send(new DeleteItemCommand({ TableName: TABLE, Key: stateKey(p.state) }));

    const creds = await readCredentials();
    let tokens;
    try {
      tokens = await exchangeAuthorizationCode({
        code: p.code,
        codeVerifier: row.Item.codeVerifier.S,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        redirectUri: REDIRECT_URI,
      });
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'token_exchange_failed', status: err?.status ?? null, detail: err?.detail ?? null }));
      return page('Could not connect', `Ring declined the exchange (HTTP ${err?.status ?? 'unknown'}).`, false);
    }

    // Tokens alone do not make a live integration: the completion PATCH is what
    // wakes device consents and webhooks up. finishLink does both and reports
    // which half succeeded, so the page can tell the truth rather than assume.
    const { record, completed } = await finishLink(OPERATOR_HOUSEHOLD, tokens, { previous: await readTokens(OPERATOR_HOUSEHOLD) });
    await linkService.recordLink(OPERATOR_HOUSEHOLD, record);

    return completed
      ? page('Connected', 'Wick can now see your Ring doorbell events. You can close this window.')
      : page(
          'Almost there',
          'Ring accepted the sign-in, but confirming the integration did not go through. '
          + 'Nothing is lost — try this link again in a moment.',
          false,
        );
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
