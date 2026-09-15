/**
 * Account Link URL.
 *
 * Ring redirects the user's browser here to begin linking. For a private app used
 * with the household's own Ring account, this hands them straight to the consent
 * page — which explains in plain language what Wick will and will not be able to
 * do — and carries the Ring parameters through.
 */
// Supplied by Terraform (var.consent_page_url) so the page can move without a
// code change. The fallback keeps local invocation working.
const CONSENT_PAGE =
  process.env.CONSENT_PAGE_URL ?? 'https://rogerjeasy.github.io/wick/link.html';

export const handler = async (event) => {
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
  return {
    statusCode: 302,
    headers: { Location: `${CONSENT_PAGE}${qs}`, 'Cache-Control': 'no-store' },
    body: '',
  };
};
