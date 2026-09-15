/**
 * Account Link URL.
 *
 * Ring redirects the user's browser here during account linking, carrying a
 * nonce. Ring's documented one-way flow POSTs the authorization code to the
 * Token Exchange URL *first*, then sends the user here; the nonce is matched
 * against that unclaimed token to complete the link.
 *
 * The exact parameter names are not documented, so this logs everything Ring
 * sends (keys and values — these are linking parameters, not household data) and
 * we build the claim step against observed reality rather than a guess.
 */
const CONSENT_PAGE =
  process.env.CONSENT_PAGE_URL ?? 'https://rogerjeasy.github.io/wick/link.html';

export const handler = async (event) => {
  // Diagnostic: capture precisely what Ring sends. Remove once the flow is known.
  console.log(JSON.stringify({
    level: 'info',
    msg: 'account_link_redirect_received',
    rawQueryString: event.rawQueryString ?? null,
    queryStringParameters: event.queryStringParameters ?? null,
    path: event.rawPath ?? null,
    method: event.requestContext?.http?.method ?? null,
    userAgent: event.requestContext?.http?.userAgent ?? null,
    referer: event.headers?.referer ?? event.headers?.referrer ?? null,
  }));

  const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
  return {
    statusCode: 302,
    headers: { Location: `${CONSENT_PAGE}${qs}`, 'Cache-Control': 'no-store' },
    body: '',
  };
};
