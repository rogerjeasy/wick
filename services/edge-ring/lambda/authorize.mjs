/**
 * The operator's way to link Ring: `GET /ring/authorize`.
 *
 * A household links its own Ring account from the family app
 * (household-link.mjs, reached only through the Wick server, which checks
 * that the person is that home's organiser). This address is the older,
 * unauthenticated one the Ring developer console and the operator use; it
 * can only ever link the operator's own household — the one this deployment
 * was set up around (WICK_HOUSEHOLD_ID) — and never one a person names.
 *
 *   GET /ring/authorize
 *     -> 302 https://account.ring.com/account/integrations/partner-link/authorize
 *
 * Ring supports two linking models. The one-way, Ring-driven flow POSTs an
 * authorization code to the Token Exchange URL and redirects the browser with a
 * nonce — but for a private app the console's "Connect Ring account" button
 * completes its own authorisation without ever calling our endpoints, so that
 * flow never fires. Partner-initiated is the one we can actually drive.
 */
import { beginAuthorization } from './authorization.mjs';

const OPERATOR_HOUSEHOLD = process.env.WICK_HOUSEHOLD_ID;

export const handler = async () => {
  const url = await beginAuthorization({ householdId: OPERATOR_HOUSEHOLD });
  return {
    statusCode: 302,
    headers: { Location: url, 'Cache-Control': 'no-store' },
    body: '',
  };
};
