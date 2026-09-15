/**
 * Ring calls that need no AWS — kept apart from the glue so they can be tested
 * against a stub fetch.
 *
 * The completion PATCH is the step that is easy to miss and expensive to miss:
 * after a partner-initiated exchange the integration sits dormant until it is
 * called. Tokens in hand and webhooks silent looks exactly like a broken
 * webhook signature, and you can lose an afternoon to that.
 */

export const TOKEN_URL = 'https://oauth.ring.com/oauth/token';
export const API_BASE = 'https://api.amazonvision.com';

class RingError extends Error {
  constructor(message, { status, detail } = {}) {
    super(message);
    this.name = 'RingError';
    this.status = status ?? null;
    this.detail = detail ?? null;
  }
}

async function readError(res) {
  try { return (await res.text()).slice(0, 400); } catch { return null; }
}

/** Exchange a refresh token for a new access token. */
export async function refreshTokens({ refreshToken, clientId, clientSecret, fetchImpl = fetch }) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    throw new RingError('refresh_failed', { status: res.status, detail: await readError(res) });
  }
  return res.json();
}

/**
 * The account this token belongs to. Ring's linking guide says to save it
 * alongside the tokens; the completion PATCH wants it as account_identifier.
 *
 * The Partner API speaks JSON:API — the identifier is `data.id`, an opaque
 * `ava1.ring.account.…` string, not a bare `account_id` at the top level. The
 * flatter shapes are kept as fallbacks only because nothing documents that the
 * envelope is guaranteed.
 */
export async function fetchAccountIdentifier({ accessToken, fetchImpl = fetch }) {
  const res = await fetchImpl(`${API_BASE}/v1/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new RingError('users_me_failed', { status: res.status, detail: await readError(res) });
  }

  const me = await res.json();
  return me?.data?.id
    ?? me?.account_id
    ?? me?.id
    ?? me?.data?.attributes?.email
    ?? me?.email
    ?? null;
}

/**
 * Mark the integration completed. Until this returns, device consents and
 * webhooks stay dormant no matter how valid the access token is.
 */
export async function completeAppIntegration({ accessToken, accountIdentifier, fetchImpl = fetch }) {
  const res = await fetchImpl(`${API_BASE}/v1/accounts/me/app-integrations`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status: 'completed',
      ...(accountIdentifier ? { account_identifier: accountIdentifier } : {}),
    }),
  });

  if (!res.ok) {
    throw new RingError('complete_integration_failed', {
      status: res.status,
      detail: await readError(res),
    });
  }
  return true;
}

export { RingError };
