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

/**
 * How long one call to Ring may take, answer and body together. Each of these
 * runs inside a Lambda of 15 or 20 seconds (infra/edge.tf), some two or three
 * calls in a row; without a bound, a Ring that accepts the connection and
 * never answers holds the function until Lambda kills it, and a household's
 * link or refresh fails with nothing but "Task timed out" in the log.
 */
export const RING_HTTP_TIMEOUT_MS = 5000;

/** A deadline for one call. Rejects, as fetch does, with a TimeoutError. */
export const ringDeadline = (timeoutMs = RING_HTTP_TIMEOUT_MS) => AbortSignal.timeout(timeoutMs);

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

/** Exchange an authorization code, with its PKCE verifier, for an account's tokens. */
export async function exchangeAuthorizationCode({ code, codeVerifier, clientId, clientSecret, redirectUri, fetchImpl = fetch, timeoutMs = RING_HTTP_TIMEOUT_MS }) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    signal: ringDeadline(timeoutMs),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    throw new RingError('token_exchange_failed', { status: res.status, detail: await readError(res) });
  }
  return res.json();
}

/** Exchange a refresh token for a new access token. */
export async function refreshTokens({ refreshToken, clientId, clientSecret, fetchImpl = fetch, timeoutMs = RING_HTTP_TIMEOUT_MS }) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    signal: ringDeadline(timeoutMs),
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
export async function fetchAccountIdentifier({ accessToken, fetchImpl = fetch, timeoutMs = RING_HTTP_TIMEOUT_MS }) {
  const res = await fetchImpl(`${API_BASE}/v1/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: ringDeadline(timeoutMs),
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
export async function completeAppIntegration({ accessToken, accountIdentifier, fetchImpl = fetch, timeoutMs = RING_HTTP_TIMEOUT_MS }) {
  const res = await fetchImpl(`${API_BASE}/v1/accounts/me/app-integrations`, {
    method: 'PATCH',
    signal: ringDeadline(timeoutMs),
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

/**
 * The devices this token can see: ids and names, nothing more. A token Ring
 * refuses throws — which is how a pasted token is checked before it is kept.
 */
export async function listDevices({ accessToken, fetchImpl = fetch, timeoutMs = RING_HTTP_TIMEOUT_MS }) {
  const res = await fetchImpl(`${API_BASE}/v1/devices`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: ringDeadline(timeoutMs),
  });

  if (!res.ok) {
    throw new RingError('devices_failed', { status: res.status, detail: await readError(res) });
  }

  const doc = await res.json();
  return (Array.isArray(doc?.data) ? doc.data : [])
    .filter((d) => typeof d?.id === 'string' && d.id)
    .map((d) => ({ id: d.id, name: typeof d.attributes?.name === 'string' ? d.attributes.name : null }));
}

export { RingError };
