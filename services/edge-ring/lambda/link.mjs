/**
 * Account Link URL.
 *
 * Ring redirects the user's browser here during account linking, carrying a
 * nonce. Ring's documented one-way flow POSTs the authorization code to the
 * Token Exchange URL *first*, then sends the user here; the nonce is matched
 * against that unclaimed token to complete the link.
 *
 * The parameter names are not documented, so this logs enough to build the claim
 * step against observed reality — but the NONCE IS A CREDENTIAL. Matching it
 * against an unclaimed token is what completes the link, so a plaintext nonce in
 * CloudWatch is a live account-linking capability for anyone who can read logs.
 *
 * We therefore log parameter names, value lengths and truncated hashes: enough to
 * identify the shape of what Ring sends and to correlate a redirect with a token
 * exchange, without ever emitting a usable value.
 */
import { createHash } from 'node:crypto';

const CONSENT_PAGE =
  process.env.CONSENT_PAGE_URL ?? 'https://rogerjeasy.github.io/wick/link.html';

/** Correlatable, not reversible. */
const fingerprint = (v) =>
  createHash('sha256').update(String(v)).digest('hex').slice(0, 12);

function describe(params) {
  return Object.fromEntries(
    Object.entries(params ?? {}).map(([k, v]) => [
      k,
      { len: String(v).length, sha256_12: fingerprint(v) },
    ]),
  );
}

export const handler = async (event) => {
  const params = event.queryStringParameters ?? {};

  console.log(JSON.stringify({
    level: 'info',
    msg: 'account_link_redirect_received',
    // Names are what we need to write the claim step; values are not.
    paramKeys: Object.keys(params),
    params: describe(params),
    method: event.requestContext?.http?.method ?? null,
    userAgent: event.requestContext?.http?.userAgent ?? null,
  }));

  // The query string is passed through to the consent page unchanged — that goes
  // to the user's own browser, which is where Ring intended it to arrive.
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
  return {
    statusCode: 302,
    headers: { Location: `${CONSENT_PAGE}${qs}`, 'Cache-Control': 'no-store' },
    body: '',
  };
};
