/**
 * The television's door to Watch live (M2), on the edge HTTP API:
 *
 *   POST   /live/sessions          { cardId }  → 201 LiveSessionResponse
 *   DELETE /live/sessions/{id}                 → 204
 *
 * This Lambda only authenticates: the device JWT, then the device's DEV#
 * item (a revoked television gets nothing). Whether that household may
 * watch, and the stream itself, are the live graph's job in the household's
 * AgentCore session (graphs/live.ts) — the household comes from the token,
 * never from the body.
 */
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { LiveRefusal } from '@wick/contracts';
import { agentCoreTarget, invokeRuntime, type RuntimeTarget } from '../runtime/invoke.js';
import { verifyDeviceToken, type DeviceClaims } from './deviceToken.js';

export interface HttpEvent {
  readonly requestContext: { readonly http: { readonly method: string } };
  readonly rawPath: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly pathParameters?: Readonly<Record<string, string | undefined>>;
}

export interface HttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface LiveHttpDeps {
  readonly verify: (token: string) => Promise<DeviceClaims>;
  readonly deviceAllowed: (householdId: string, deviceId: string) => Promise<boolean>;
  readonly invoke: (kind: string, householdId: string, payload: Record<string, unknown>) => Promise<unknown>;
}

const STATUS_FOR: Record<LiveRefusal | 'bad_request', number> = {
  no_such_card: 404,
  card_too_old: 410,
  camera_unavailable: 503,
  camera_unsupported: 422,
  bad_request: 400,
};

const json = (statusCode: number, body: unknown): HttpResponse => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const SESSION_PATH = /^\/live\/sessions\/([A-Za-z0-9_-]{1,64})$/;

function readCardId(event: HttpEvent): string | null {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    const parsed = JSON.parse(raw) as { cardId?: unknown };
    return typeof parsed.cardId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(parsed.cardId) ? parsed.cardId : null;
  } catch {
    return null;
  }
}

export async function handleLiveHttp(event: HttpEvent, deps: LiveHttpDeps): Promise<HttpResponse> {
  const method = event.requestContext.http.method;
  const stopMatch = SESSION_PATH.exec(event.rawPath);
  const isStart = method === 'POST' && event.rawPath === '/live/sessions';
  const isStop = method === 'DELETE' && stopMatch !== null;
  if (!isStart && !isStop) return json(404, { error: 'not_found' });

  const auth = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = /^Bearer (\S+)$/.exec(auth)?.[1];
  let claims: DeviceClaims;
  try {
    if (!token) throw new Error('no_token');
    claims = await deps.verify(token);
  } catch {
    return json(401, { error: 'unauthorized' });
  }
  if (!(await deps.deviceAllowed(claims.householdId, claims.deviceId))) return json(403, { error: 'unauthorized' });

  if (isStop) {
    try {
      await deps.invoke('live.stop', claims.householdId, { sessionId: stopMatch![1] });
    } catch (err) {
      // Ring ends the session itself within a minute; the TV has already left.
      console.error(JSON.stringify({ level: 'warn', msg: 'live_stop_failed', err: err instanceof Error ? err.message : 'unknown' }));
    }
    return { statusCode: 204, headers: {}, body: '' };
  }

  const cardId = readCardId(event);
  if (!cardId) return json(400, { error: 'bad_request' });

  let out: unknown;
  try {
    out = await deps.invoke('live.start', claims.householdId, { cardId });
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'live_start_failed', cardId, err: err instanceof Error ? err.message : 'unknown' }));
    return json(503, { error: 'camera_unavailable' });
  }

  const error = (out as { error?: unknown }).error;
  if (typeof error === 'string') return json(STATUS_FOR[error as LiveRefusal] ?? 500, { error });
  console.log(JSON.stringify({ level: 'info', msg: 'live_started', cardId, sessionId: (out as { sessionId?: unknown }).sessionId }));
  return json(201, out);
}

// ── composition root (untested, like the other Lambda shims) ────────────────

const ddb = new DynamoDBClient({});
const sm = new SecretsManagerClient({});
const TABLE = process.env.TABLE_NAME ?? '';
let publicKey: string | undefined;
let target: RuntimeTarget | undefined;

async function signingPublicKey(): Promise<string> {
  if (publicKey) return publicKey;
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: process.env.PAIRING_SIGNING_KEY_SECRET_ARN }));
  publicKey = (JSON.parse(secret.SecretString ?? '{}') as { publicKeyPem?: string }).publicKeyPem ?? '';
  return publicKey;
}

export const handler = async (event: HttpEvent): Promise<HttpResponse> => {
  target ??= agentCoreTarget();
  const t = target;
  return handleLiveHttp(event, {
    verify: async (token) => verifyDeviceToken(token, await signingPublicKey()),
    deviceAllowed: async (householdId, deviceId) => {
      const res = await ddb.send(new GetItemCommand({
        TableName: TABLE,
        Key: { pk: { S: `HH#${householdId}` }, sk: { S: `DEV#${deviceId}` } },
      }));
      return Boolean(res.Item) && res.Item?.denylisted?.BOOL !== true;
    },
    invoke: (kind, householdId, payload) => invokeRuntime(t, kind, householdId, payload),
  });
};
