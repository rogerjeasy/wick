/**
 * The Ring webhook, through its real handler, with the secret, the table and
 * the bus handed in. The payloads are the ones Ring documents
 * (developer.amazon.com/docs/ring/api-documentation.html, "Webhook v1.1
 * Payload Structure", "Button Press", "Motion Detection"), with their
 * placeholders filled and their times moved to the test's clock.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { isDoorWorthy, toRingHistoryEvent } from '../../../agent/src/agents/door/parseEvent.js';
import {
  IDEMPOTENCY_TTL_SEC,
  MAX_EVENT_AGE_MS,
  MAX_EVENT_LEAD_MS,
  SIGNATURE_HEADER,
  createWebhookHandler,
  readRingEvent,
  sentAtOf,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../webhook-receiver.mjs';

const KEY = 'ring-hmac-signing-key-for-tests';
const NOW = Date.parse('2026-10-16T09:00:00.000Z');
const DEVICE = 'ava1.ring.device.TESTDOORBELL';

type Row = Record<string, { S?: string; N?: string; BOOL?: boolean }>;
type Envelope = { meta: Record<string, unknown>; data: Record<string, unknown> };

/** Ring's documented button_press, sent `sentAgoMs` before NOW. */
function buttonPress(overrides: { requestId?: string; sentAt?: number; meta?: Record<string, unknown> } = {}): Envelope {
  const sentAt = overrides.sentAt ?? NOW - 1_000;
  const pressedAt = sentAt - 2_000;
  return {
    meta: {
      version: '1.1',
      time: new Date(sentAt).toISOString().replace('Z', '027052Z'), // Ring writes nanoseconds
      request_id: overrides.requestId ?? 'c83081fc-2f1b-4cb7-8b18-b18a318b8bab',
      account_id: 'ava1.ring.account.XXXYYY',
      ...overrides.meta,
    },
    data: {
      id: `${DEVICE}_button_press_${pressedAt}`,
      type: 'button_press',
      attributes: { source: DEVICE, source_type: 'devices', timestamp: pressedAt },
      relationships: { devices: { links: { self: `/v1/devices/${DEVICE}` } } },
    },
  };
}

const sign = (body: string | Buffer, key = KEY) => `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;

/** A table that honours the one condition the webhook writes with, and nothing more. */
function fakeTable(options: { fail?: string } = {}) {
  const rows = new Map<string, Row>();
  const puts: Row[] = [];
  const putItem = vi.fn(async (input: { TableName: string; Item: Row; ConditionExpression?: string }) => {
    expect(input.TableName).toBe('wick');
    if (options.fail) throw Object.assign(new Error('table'), { name: options.fail });
    const item = input.Item;
    const key = `${item.pk!.S}|${item.sk!.S}`;
    const existing = rows.get(key);
    if (input.ConditionExpression) {
      expect(input.ConditionExpression).toBe('attribute_not_exists(pk) OR attribute_exists(released)');
      if (existing && !existing.released) throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
    }
    rows.set(key, item);
    puts.push(item);
    return {};
  });
  return { rows, puts, putItem };
}

function fakeBus(options: { fail?: 'throw' | 'reject' } = {}) {
  const entries: { Source: string; DetailType: string; EventBusName: string; Detail: Record<string, unknown> }[] = [];
  let failing = options.fail;
  type Entry = { Source?: string; DetailType?: string; EventBusName?: string; Detail?: string };
  const putEvents = vi.fn(async (input: { Entries?: Entry[] }) => {
    if (failing === 'throw') throw Object.assign(new Error('bus'), { name: 'InternalException' });
    if (failing === 'reject') return { FailedEntryCount: 1, Entries: [{ ErrorCode: 'InternalFailure' }] };
    for (const e of input.Entries ?? []) {
      entries.push({ Source: e.Source!, DetailType: e.DetailType!, EventBusName: e.EventBusName!, Detail: JSON.parse(e.Detail!) });
    }
    return { FailedEntryCount: 0, Entries: [{ EventId: 'e-1' }] };
  });
  return { entries, putEvents, heal: () => { failing = undefined; } };
}

function harness(options: { readKey?: () => Promise<string>; table?: ReturnType<typeof fakeTable>; bus?: ReturnType<typeof fakeBus>; now?: () => number } = {}) {
  const table = options.table ?? fakeTable();
  const bus = options.bus ?? fakeBus();
  const readKey = vi.fn(options.readKey ?? (async () => KEY));
  let ids = 0;
  const handler = createWebhookHandler({
    readKey,
    putItem: table.putItem,
    putEvents: bus.putEvents,
    table: 'wick',
    busName: 'wick',
    now: options.now ?? (() => NOW),
    newId: () => `corr-${(ids += 1)}`,
  });
  return { handler, table, bus, readKey };
}

/** An API Gateway HTTP API (v2) event, as it hands Ring's POST to the Lambda. */
function request(body: string, headers: Record<string, string> = { [SIGNATURE_HEADER]: sign(body) }, isBase64Encoded = false) {
  return { body: isBase64Encoded ? Buffer.from(body).toString('base64') : body, headers: { 'content-type': 'application/json', ...headers }, isBase64Encoded };
}

describe('the Ring webhook: signature (X-Signature, sha256=<hex>, over the raw body)', () => {
  it('accepts a body signed as Ring documents, and puts one event on the bus', async () => {
    const { handler, bus, table } = harness();
    const body = JSON.stringify(buttonPress());
    expect(await handler(request(body))).toEqual({ statusCode: 200, body: '' });
    expect(bus.entries).toHaveLength(1);
    expect(bus.entries[0]).toMatchObject({ Source: 'wick.ring', DetailType: 'button_press', EventBusName: 'wick' });
    expect(table.rows.has('IDEM#c83081fc-2f1b-4cb7-8b18-b18a318b8bab|META')).toBe(true);
  });

  it('reads the header whatever its case', async () => {
    const { handler, bus } = harness();
    const body = JSON.stringify(buttonPress());
    expect((await handler(request(body, { 'X-Signature': sign(body) }))).statusCode).toBe(200);
    expect(bus.entries).toHaveLength(1);
  });

  it('accepts the bare hex digest too, as Ring’s own sample does (removeprefix)', async () => {
    const { handler } = harness();
    const body = JSON.stringify(buttonPress());
    expect((await handler(request(body, { [SIGNATURE_HEADER]: sign(body).slice('sha256='.length) }))).statusCode).toBe(200);
  });

  it('signs the bytes as they came: a base64-encoded body is verified on its decoded bytes', async () => {
    const { handler } = harness();
    const body = JSON.stringify(buttonPress());
    expect((await handler(request(body, { [SIGNATURE_HEADER]: sign(body) }, true))).statusCode).toBe(200);
  });

  it('verifies the raw bytes, not a re-encoding: a body that is not UTF-8 is verified on its bytes', async () => {
    const { handler } = harness();
    // A lone 0xff would become U+FFFD if the body were decoded to a string and encoded again.
    const bytes = Buffer.concat([Buffer.from(JSON.stringify(buttonPress()).slice(0, -1)), Buffer.from(',"x":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    const event = { body: bytes.toString('base64'), isBase64Encoded: true, headers: { [SIGNATURE_HEADER]: sign(bytes) } };
    const wrong = { ...event, headers: { [SIGNATURE_HEADER]: sign(Buffer.from(bytes.toString('utf8'))) } };
    expect((await handler(event)).statusCode).toBe(200);
    expect((await harness().handler(wrong)).statusCode).toBe(401);
  });

  it('refuses a wrong signature with 401, and writes and publishes nothing', async () => {
    const { handler, bus, table } = harness();
    const body = JSON.stringify(buttonPress());
    expect(await handler(request(body, { [SIGNATURE_HEADER]: `sha256=${'0'.repeat(64)}` }))).toEqual({ statusCode: 401, body: '' });
    expect(table.puts).toHaveLength(0);
    expect(bus.entries).toHaveLength(0);
  });

  it('refuses a missing signature with 401', async () => {
    const { handler, table } = harness();
    expect((await handler(request(JSON.stringify(buttonPress()), {}))).statusCode).toBe(401);
    expect((await handler(request(JSON.stringify(buttonPress()), { [SIGNATURE_HEADER]: '' }))).statusCode).toBe(401);
    expect((await handler(request(JSON.stringify(buttonPress()), { [SIGNATURE_HEADER]: 'sha256=' }))).statusCode).toBe(401);
    expect(table.puts).toHaveLength(0);
  });

  it('refuses a signature of the wrong length without comparing it', async () => {
    const { handler } = harness();
    const body = JSON.stringify(buttonPress());
    const good = sign(body);
    expect((await handler(request(body, { [SIGNATURE_HEADER]: good.slice(0, -1) }))).statusCode).toBe(401);
    expect((await handler(request(body, { [SIGNATURE_HEADER]: `${good}0` }))).statusCode).toBe(401);
  });

  it('refuses a body signed with another key', async () => {
    const { handler } = harness();
    const body = JSON.stringify(buttonPress());
    expect((await handler(request(body, { [SIGNATURE_HEADER]: sign(body, 'somebody-elses-key') }))).statusCode).toBe(401);
  });

  it('refuses a body changed after it was signed', async () => {
    const { handler, bus } = harness();
    const body = JSON.stringify(buttonPress());
    const signature = sign(body);
    const tampered = body.replace(DEVICE, 'ava1.ring.device.SOMEONEELSE');
    expect((await handler(request(tampered, { [SIGNATURE_HEADER]: signature }))).statusCode).toBe(401);
    // Even whitespace: Ring signs bytes, and so does this.
    expect((await handler(request(`${body} `, { [SIGNATURE_HEADER]: signature }))).statusCode).toBe(401);
    expect(bus.entries).toHaveLength(0);
  });

  it('reads only the header Ring documents: the old guesses carry no weight', async () => {
    const { handler, table } = harness();
    const body = JSON.stringify(buttonPress());
    for (const name of ['x-ring-signature', 'x-amz-signature', 'x-hub-signature-256', 'signature', 'authorization']) {
      expect((await handler(request(body, { [name]: sign(body) }))).statusCode, name).toBe(401);
    }
    // And a wrong X-Signature is not rescued by a right one under another name.
    expect((await handler(request(body, { [SIGNATURE_HEADER]: 'sha256=00', 'x-ring-signature': sign(body) }))).statusCode).toBe(401);
    expect(table.puts).toHaveLength(0);
  });
});

describe('the Ring webhook: the body', () => {
  it('refuses a signed body that is not JSON with 400, so Ring does not send it again', async () => {
    const { handler, table } = harness();
    expect(await handler(request('{"meta":'))).toEqual({ statusCode: 400, body: '' });
    expect(table.puts).toHaveLength(0);
  });

  it('refuses a signed body with no meta.request_id with 400', async () => {
    const { handler, table } = harness();
    const event = buttonPress();
    delete event.meta.request_id;
    expect((await handler(request(JSON.stringify(event)))).statusCode).toBe(400);
    expect((await handler(request(JSON.stringify(buttonPress({ meta: { request_id: '' } }))))).statusCode).toBe(400);
    expect(table.puts).toHaveLength(0);
  });

  it('refuses the flat shape Wick used to guess at (request_id at the top): Ring documents v1.1 only', async () => {
    const { handler } = harness();
    const flat = { request_id: 'r-1', event_type: 'button_press', device_id: DEVICE, occurred_at: NOW };
    expect((await handler(request(JSON.stringify(flat)))).statusCode).toBe(400);
  });

  it('refuses a body with no meta.time, or one that is not an ISO instant', async () => {
    const { handler } = harness();
    for (const time of [undefined, '', 'yesterday', 1770989997200, '2026-02-13 13:39:57', '2026-02-13T13:39:57']) {
      expect((await handler(request(JSON.stringify(buttonPress({ meta: { time } }))))).statusCode, String(time)).toBe(400);
    }
  });

  it('refuses a body with no data.type', async () => {
    const { handler } = harness();
    const event = buttonPress();
    delete event.data.type;
    expect((await handler(request(JSON.stringify(event)))).statusCode).toBe(400);
  });

  it('puts the Door agent’s flat detail on the bus, read from Ring’s envelope, with a correlation id', async () => {
    const { handler, bus } = harness();
    const event = buttonPress();
    await handler(request(JSON.stringify(event)));
    const attributes = event.data.attributes as { timestamp: number };
    expect(bus.entries[0]!.Detail).toEqual({
      request_id: 'c83081fc-2f1b-4cb7-8b18-b18a318b8bab',
      event_type: 'button_press',
      device_id: DEVICE,
      occurred_at: attributes.timestamp,
      ring_event_id: event.data.id,
      account_id: 'ava1.ring.account.XXXYYY',
      sent_at: NOW - 1_000,
      correlationId: 'corr-1',
      receivedAt: NOW,
    });
  });

  it('is what the Door agent reads: a documented press becomes a door-worthy event on Ring’s own device and time', async () => {
    const { handler, bus } = harness();
    const event = buttonPress();
    await handler(request(JSON.stringify(event)));
    const detail = bus.entries[0]!.Detail;
    expect(isDoorWorthy(detail)).toBe(true);
    expect(toRingHistoryEvent(detail, String(detail.correlationId))).toEqual({
      id: 'c83081fc-2f1b-4cb7-8b18-b18a318b8bab',
      deviceId: DEVICE,
      start: (event.data.attributes as { timestamp: number }).timestamp,
      eventType: 'button_press',
      detections: [],
    });
  });

  it('carries a motion event’s sub_type and component_ids from attributes', async () => {
    const { handler, bus } = harness();
    const event = buttonPress();
    event.data.type = 'motion_detected';
    event.data.attributes = { source: DEVICE, source_type: 'devices', timestamp: NOW - 3_000, timestamp_readable: '2026-10-16 08:59:57', sub_type: 'human', component_ids: ['0'] };
    await handler(request(JSON.stringify(event)));
    expect(bus.entries[0]).toMatchObject({ DetailType: 'motion_detected', Detail: { event_type: 'motion_detected', sub_type: 'human', device_id: DEVICE, component_ids: ['0'] } });
  });

  it('passes an event that is not from a device (a subscription) with no device_id, for the agent to drop', async () => {
    const { handler, bus } = harness();
    const event = buttonPress();
    event.data = { id: 'evt-1', type: 'subscription_activated', attributes: { source: 'subscriptions', source_id: 'sub-1', sub_type: 'paid' } };
    expect((await handler(request(JSON.stringify(event)))).statusCode).toBe(200);
    expect(bus.entries[0]!.Detail.device_id).toBeUndefined();
    expect(bus.entries[0]!.DetailType).toBe('subscription_activated');
  });

  it('reads Ring’s nanosecond time to the millisecond', () => {
    expect(sentAtOf('2026-02-13T13:39:57.200155525Z')).toBe(Date.parse('2026-02-13T13:39:57.200Z'));
    expect(sentAtOf('2026-07-06T11:11:00Z')).toBe(Date.parse('2026-07-06T11:11:00Z'));
    expect(sentAtOf('2026-07-06T13:11:00.5+02:00')).toBe(Date.parse('2026-07-06T11:11:00.500Z'));
    expect(readRingEvent({ meta: { request_id: 'r', time: '2026-07-06T11:11:00Z' }, data: { type: 'button_press' } }).error).toBeUndefined();
  });
});

describe('the Ring webhook: the window on meta.time', () => {
  const at = (sentAt: number) => JSON.stringify(buttonPress({ sentAt }));

  it('is five minutes back and one minute ahead', () => {
    expect(MAX_EVENT_AGE_MS).toBe(5 * 60_000);
    expect(MAX_EVENT_LEAD_MS).toBe(60_000);
  });

  // Dropped with a 200, never a 4xx: Ring counts repeated 4xx toward disabling the endpoint,
  // and a late retry of Ring's own would otherwise be one.
  it('accepts an event sent exactly five minutes ago, and drops one a millisecond older with 200 and nothing on the bus', async () => {
    expect((await harness().handler(request(at(NOW - MAX_EVENT_AGE_MS)))).statusCode).toBe(200);
    const late = harness();
    expect(await late.handler(request(at(NOW - MAX_EVENT_AGE_MS - 1)))).toEqual({ statusCode: 200, body: '' });
    expect(late.table.puts).toHaveLength(0);
    expect(late.bus.entries).toHaveLength(0);
  });

  it('accepts an event stamped exactly a minute ahead, and drops one a millisecond further with 200 and nothing on the bus', async () => {
    expect((await harness().handler(request(at(NOW + MAX_EVENT_LEAD_MS)))).statusCode).toBe(200);
    const early = harness();
    expect((await early.handler(request(at(NOW + MAX_EVENT_LEAD_MS + 1)))).statusCode).toBe(200);
    expect(early.bus.entries).toHaveLength(0);
  });

  it('is under the signature: moving meta.time into the window breaks the signature', async () => {
    const { handler, bus } = harness();
    const old = at(NOW - 60 * 60_000);
    const signature = sign(old);
    const freshened = old.replace(/"time":"[^"]+"/, `"time":"${new Date(NOW).toISOString()}"`);
    expect((await handler(request(old, { [SIGNATURE_HEADER]: signature }))).statusCode).toBe(200);
    expect((await handler(request(freshened, { [SIGNATURE_HEADER]: signature }))).statusCode).toBe(401);
    expect(bus.entries).toHaveLength(0);
  });

  it('a replay of a body accepted a day ago — its request_id long forgotten — is dropped', async () => {
    let now = NOW;
    const { handler, table, bus } = harness({ now: () => now });
    const body = at(NOW - 1_000);
    expect((await handler(request(body))).statusCode).toBe(200);
    table.rows.clear(); // the 24-hour TTL has let the row go
    now = NOW + IDEMPOTENCY_TTL_SEC * 1000 + 1;
    expect((await handler(request(body))).statusCode).toBe(200);
    expect(bus.entries).toHaveLength(1);
  });
});

describe('the Ring webhook: idempotency and failure', () => {
  it('answers a duplicate request_id 200 and puts no second event on the bus', async () => {
    const { handler, bus } = harness();
    const body = JSON.stringify(buttonPress());
    expect((await handler(request(body))).statusCode).toBe(200);
    expect((await handler(request(body))).statusCode).toBe(200);
    // Ring's retry carries the same request_id and may carry a new meta.time: still one event.
    expect((await handler(request(JSON.stringify(buttonPress({ sentAt: NOW }))))).statusCode).toBe(200);
    expect(bus.entries).toHaveLength(1);
  });

  it('remembers a request_id for 24 hours', async () => {
    const { handler, table } = harness();
    await handler(request(JSON.stringify(buttonPress())));
    expect(table.puts[0]!.ttl!.N).toBe(String(Math.floor(NOW / 1000) + IDEMPOTENCY_TTL_SEC));
  });

  it('answers 500 when the HMAC key cannot be read, so Ring retries; and reads it again next time', async () => {
    let calls = 0;
    const { handler, readKey, table } = harness({ readKey: async () => { calls += 1; if (calls === 1) throw new Error('throttled'); return KEY; } });
    const body = JSON.stringify(buttonPress());
    expect((await handler(request(body))).statusCode).toBe(500);
    expect(table.puts).toHaveLength(0);
    expect((await handler(request(body))).statusCode).toBe(200);
    expect((await handler(request(JSON.stringify(buttonPress({ requestId: 'another' }))))).statusCode).toBe(200);
    expect(readKey).toHaveBeenCalledTimes(2); // cached once read
  });

  it('answers 500 when the secret holds no key', async () => {
    expect((await harness({ readKey: async () => '' }).handler(request(JSON.stringify(buttonPress())))).statusCode).toBe(500);
  });

  it('answers 500 when the idempotency write fails for any other reason, and publishes nothing', async () => {
    const { handler, bus } = harness({ table: fakeTable({ fail: 'ProvisionedThroughputExceededException' }) });
    expect((await handler(request(JSON.stringify(buttonPress())))).statusCode).toBe(500);
    expect(bus.entries).toHaveLength(0);
  });

  for (const fail of ['throw', 'reject'] as const) {
    it(`answers 500 when the bus ${fail === 'throw' ? 'throws' : 'rejects the entry'} — and Ring’s retry is then taken, not swallowed as a duplicate`, async () => {
      const bus = fakeBus({ fail });
      const { handler, table } = harness({ bus });
      const body = JSON.stringify(buttonPress());
      expect((await handler(request(body))).statusCode).toBe(500);
      expect(table.rows.get('IDEM#c83081fc-2f1b-4cb7-8b18-b18a318b8bab|META')?.released).toEqual({ BOOL: true });
      bus.heal();
      expect((await handler(request(body))).statusCode).toBe(200);
      expect(bus.entries).toHaveLength(1);
      expect(table.rows.get('IDEM#c83081fc-2f1b-4cb7-8b18-b18a318b8bab|META')?.released).toBeUndefined();
      // And once taken, it is a duplicate again.
      expect((await handler(request(body))).statusCode).toBe(200);
      expect(bus.entries).toHaveLength(1);
    });
  }
});
