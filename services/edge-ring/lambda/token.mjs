/**
 * Ring token exchange.
 *
 * Ring POSTs an authorization code here, server-to-server, during account linking.
 * We exchange it for access + refresh tokens and store them.
 *
 * INV-1: tokens are written to Secrets Manager and never leave the backend. The
 * television holds a device-bound JWT and nothing else.
 */
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand }
  from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({});
const SECRET_ARN = process.env.RING_SECRET_ARN;
const TOKEN_SECRET_ARN = process.env.RING_TOKEN_SECRET_ARN;
const TOKEN_URL = 'https://oauth.ring.com/oauth/token';

export const handler = async (event) => {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');

  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { body = Object.fromEntries(new URLSearchParams(raw)); }

  const code = body.code ?? body.authorization_code;
  if (!code) return { statusCode: 400, body: JSON.stringify({ error: 'missing_code' }) };

  const creds = JSON.parse(
    (await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }))).SecretString,
  );

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

  const tokens = await res.json();
  await sm.send(new PutSecretValueCommand({
    SecretId: TOKEN_SECRET_ARN,
    SecretString: JSON.stringify({ ...tokens, obtainedAt: Date.now() }),
  }));

  console.log(JSON.stringify({ level: 'info', msg: 'account_linked' }));
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
