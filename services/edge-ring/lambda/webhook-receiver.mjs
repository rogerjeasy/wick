/**
 * Ring webhook receiver: the handler, with what it reaches handed in (webhook.mjs wires it).
 *
 * The entire design is Ring's five-second acknowledgement budget:
 *
 *   1. verify HMAC-SHA256 over the raw body (constant time)
 *   2. read Ring's v1.1 envelope, and refuse one Ring sent too long ago
 *   3. idempotency: conditional PutItem on meta.request_id, TTL 24h
 *   4. PutEvents -> EventBridge
 *   5. return 200
 *
 * Nothing else on this path. No Ring API calls, no model calls, no extra writes.
 * Everything downstream is async off the bus. Target p99 < 150ms.
 *
 * What Ring documents, and so what this follows (developer.amazon.com/docs/ring/
 * api-documentation.html, "Notifications", read 2026-10-16):
 *
 *   - the signature is in `X-Signature`, as `sha256=<hex HMAC-SHA256>`, keyed
 *     with the partner's HMAC signing key, over the raw body bytes;
 *   - every webhook is the v1.1 JSON:API envelope: `meta.{version, time,
 *     request_id, account_id}` and `data.{id, type, attributes}`, with a
 *     device event's `attributes.{source, timestamp, sub_type}`;
 *   - 2xx is delivered; 4xx is permanent and never retried; 5xx and a
 *     timeout are retried (1 s, 5 s, 30 s, 2 min, 10 min, 1 h), then dead-lettered.
 *
 * Ring documents no replay protection for a webhook: no timestamp header and
 * nothing signed beside the body. So the window below is on `meta.time` — "when
 * Ring sent the webhook" — which is inside the body and so under the signature.
 * Whether Ring stamps it afresh on a retry or a dead-letter replay is not said
 * (FRICTION.md FL-041).
 *
 * INV-6: correlationId is minted HERE and must survive to the device.
 * See docs/WICK-TECHNICAL.md §7.1, §9.1.
 */
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

/** The one header Ring documents for the signature. API Gateway hands headers over lower-cased. */
export const SIGNATURE_HEADER = 'x-signature';

/** A correctly signed event Ring sent longer ago than this is refused: it is a replay, or too late to be a door. */
export const MAX_EVENT_AGE_MS = 5 * 60_000;
/** ...and one stamped further ahead of this clock than this. Clocks differ; by more than a minute, the stamp is wrong. */
export const MAX_EVENT_LEAD_MS = 60_000;

/** How long a request_id is remembered. Longer than the window, so nothing inside it is taken twice. */
export const IDEMPOTENCY_TTL_SEC = 24 * 60 * 60;

/** ISO 8601 with a zone, as Ring writes `meta.time` ("2026-02-13T13:39:57.200155525Z"). Nothing looser is a time. */
const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

const EMPTY = (statusCode) => ({ statusCode, body: '' });

/** `meta.time` in epoch milliseconds, or undefined when it is not an ISO instant. */
export function sentAtOf(time) {
  if (typeof time !== 'string') return undefined;
  const m = ISO_INSTANT.exec(time);
  if (!m) return undefined;
  // Ring writes nanoseconds; Date.parse is only promised milliseconds.
  const at = Date.parse(`${m[1]}${m[2] ? `.${m[2].slice(0, 3).padEnd(3, '0')}` : ''}${m[3]}`);
  return Number.isFinite(at) ? at : undefined;
}

/** HMAC-SHA256 of the raw bytes, hex, compared in constant time. `sha256=` is Ring's prefix; its own sample also accepts none. */
export function verifySignature(rawBody, signature, key) {
  if (typeof signature !== 'string' || !signature || typeof key !== 'string' || !key) return false;
  const expected = Buffer.from(createHmac('sha256', key).update(rawBody).digest('hex'), 'utf8');
  const given = Buffer.from(signature.trim().replace(/^sha256=/, ''), 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Ring's v1.1 envelope, read into the flat detail the Door agent takes
 * (services/agent agents/door/parseEvent.ts): `request_id`, `event_type`,
 * `sub_type`, `device_id`, `occurred_at`. Returns `{ error }` for a body that
 * is not one — a permanent 4xx, as Ring's own sample answers it.
 */
export function readRingEvent(payload) {
  const meta = payload?.meta;
  const data = payload?.data;
  if (!meta || typeof meta !== 'object' || !data || typeof data !== 'object') return { error: 'not_v1_1' };
  const requestId = meta.request_id;
  if (typeof requestId !== 'string' || !requestId) return { error: 'missing_request_id' };
  const sentAt = sentAtOf(meta.time);
  if (sentAt === undefined) return { error: 'missing_time' };
  if (typeof data.type !== 'string' || !data.type) return { error: 'missing_type' };
  const attributes = data.attributes && typeof data.attributes === 'object' ? data.attributes : {};
  const fromDevice = attributes.source_type === 'devices' && typeof attributes.source === 'string';
  return {
    requestId,
    sentAt,
    detail: {
      request_id: requestId,
      event_type: data.type,
      ...(typeof attributes.sub_type === 'string' ? { sub_type: attributes.sub_type } : {}),
      ...(fromDevice ? { device_id: attributes.source } : {}),
      ...(typeof attributes.timestamp === 'number' ? { occurred_at: attributes.timestamp } : {}),
      ...(Array.isArray(attributes.component_ids) ? { component_ids: attributes.component_ids.filter((c) => typeof c === 'string') } : {}),
      ...(typeof data.id === 'string' ? { ring_event_id: data.id } : {}),
      ...(typeof meta.account_id === 'string' ? { account_id: meta.account_id } : {}),
      sent_at: sentAt,
    },
  };
}

/** Whether Ring's send time is inside the window around `now`. Both edges are inside. */
export function insideWindow(sentAt, now) {
  return now - sentAt <= MAX_EVENT_AGE_MS && sentAt - now <= MAX_EVENT_LEAD_MS;
}

const log = (level, msg, extra = {}) => {
  const line = JSON.stringify({ level, msg, ...extra });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

/**
 * The handler, with everything it reaches handed in: `readKey` (the HMAC key),
 * `putItem` and `putEvents` (each sends one DynamoDB PutItem / EventBridge
 * PutEvents input), the table and bus names, the clock and the id maker. The
 * production wiring is webhook.mjs.
 */
export function createWebhookHandler({ readKey, putItem, putEvents, table, busName, now = Date.now, newId = randomUUID }) {
  let cachedKey = null; // container-scoped; avoids a Secrets call per event. A failure is not cached.

  const idemKey = (requestId) => ({ pk: { S: `IDEM#${requestId}` }, sk: { S: 'META' } });

  return async (event) => {
    // The bytes Ring signed, exactly as they came: never a re-encoding of a decoded string.
    const raw = Buffer.from(event?.body ?? '', event?.isBase64Encoded ? 'base64' : 'utf8');

    const headers = Object.fromEntries(Object.entries(event?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const signature = headers[SIGNATURE_HEADER];

    // 1 — authenticity. A key we cannot read is our failure, and Ring should try again.
    let key;
    try {
      key = cachedKey ?? (await readKey());
      if (typeof key !== 'string' || !key) throw new Error('no key');
      cachedKey = key;
    } catch {
      log('error', 'secret_unavailable');
      return EMPTY(500);
    }
    if (!verifySignature(raw, signature, key)) {
      log('warn', signature ? 'bad_signature' : 'missing_signature');
      return EMPTY(401);
    }

    // 2 — Ring's envelope, and when Ring sent it.
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      log('warn', 'bad_json');
      return EMPTY(400);
    }
    const ring = readRingEvent(payload);
    if (ring.error) {
      log('warn', 'bad_payload', { reason: ring.error });
      return EMPTY(400);
    }
    const receivedAt = now();
    if (!insideWindow(ring.sentAt, receivedAt)) {
      // Signed by Ring, but not now: a replay of a body seen before, or one held back.
      // 4xx, so Ring does not send it again.
      log('warn', 'outside_window', { requestId: ring.requestId, skewMs: receivedAt - ring.sentAt });
      return EMPTY(400);
    }

    // 3 — idempotency. A duplicate is a success, not an error: Ring retries, and a
    //     non-200 would make it retry harder. A row a failed hand-off released is
    //     taken again, so Ring's retry of a 500 is not swallowed as a duplicate.
    try {
      await putItem({
        TableName: table,
        Item: { ...idemKey(ring.requestId), ttl: { N: String(Math.floor(receivedAt / 1000) + IDEMPOTENCY_TTL_SEC) } },
        ConditionExpression: 'attribute_not_exists(pk) OR attribute_exists(released)',
      });
    } catch (e) {
      if (e?.name === 'ConditionalCheckFailedException') {
        log('info', 'duplicate', { requestId: ring.requestId });
        return EMPTY(200);
      }
      log('error', 'idem_failed', { err: e?.name });
      return EMPTY(500);
    }

    // 4 — hand off and get out of the way
    const correlationId = newId();
    try {
      const out = await putEvents({
        Entries: [{
          EventBusName: busName,
          Source: 'wick.ring',
          DetailType: ring.detail.event_type,
          Detail: JSON.stringify({ ...ring.detail, correlationId, receivedAt }),
        }],
      });
      if (out?.FailedEntryCount) throw Object.assign(new Error('entry rejected'), { name: out.Entries?.[0]?.ErrorCode ?? 'FailedEntry' });
    } catch (e) {
      log('error', 'bus_failed', { correlationId, err: e?.name });
      // Let the retry through: mark the claim released (PutItem only — the role may not delete).
      try {
        await putItem({
          TableName: table,
          Item: { ...idemKey(ring.requestId), released: { BOOL: true }, ttl: { N: String(Math.floor(receivedAt / 1000) + IDEMPOTENCY_TTL_SEC) } },
        });
      } catch (release) {
        log('error', 'idem_release_failed', { correlationId, err: release?.name });
      }
      return EMPTY(500);
    }

    log('info', 'accepted', { correlationId, type: ring.detail.event_type, requestId: ring.requestId });
    return EMPTY(200);
  };
}
