/**
 * Ring token exchange.
 *
 * Ring POSTs an authorization code here, server-to-server, during account linking.
 * We exchange it for access + refresh tokens and store them.
 *
 * INV-1: tokens are written to Secrets Manager and never leave the backend. The
 * television holds a device-bound JWT and nothing else.
 */
import { readCredentials, readTokens, finishLink } from './ring-token.mjs';
import { TOKEN_URL } from './ring-api.mjs';

export const handler = async (event) => {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');

  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { body = Object.fromEntries(new URLSearchParams(raw)); }

  // Diagnostic: Ring's token-exchange payload shape is not documented. Log the
  // KEYS only — never the values, which carry the authorization code.
  console.log(JSON.stringify({
    level: 'info',
    msg: 'token_exchange_received',
    bodyKeys: Object.keys(body),
    queryKeys: Object.keys(event.queryStringParameters ?? {}),
    contentType: (event.headers ?? {})['content-type'] ?? null,
  }));

  const code = body.code ?? body.authorization_code;
  if (!code) return { statusCode: 400, body: JSON.stringify({ error: 'missing_code' }) };

  const creds = await readCredentials();

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      ...(body.redirect_uri ? { redirect_uri: body.redirect_uri } : {}),
      ...(body.code_verifier ? { code_verifier: body.code_verifier } : {}),
    }),
  });

  if (!res.ok) {
    console.error(JSON.stringify({ level: 'error', msg: 'token_exchange_failed', status: res.status }));
    return { statusCode: 502, body: JSON.stringify({ error: 'exchange_failed' }) };
  }

  // Same completion step as the partner-initiated path: tokens are not a live
  // integration until Ring is told the link is done.
  const tokens = await res.json();
  const { completed } = await finishLink(tokens, { previous: await readTokens() });

  return { statusCode: 200, body: JSON.stringify({ ok: true, completed }) };
};
