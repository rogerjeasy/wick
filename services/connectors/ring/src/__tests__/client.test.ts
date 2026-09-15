import { describe, it, expect } from 'vitest';
import { RingClient, RingApiError } from '../client.js';
import { listDevices } from '../devices.js';
import { latestEvent, listEvents } from '../history.js';
import { imageAt, selectorForEvent, fetchImageBytes, imageForEvent } from '../media.js';

type Call = { url: string; init: RequestInit };

function stub(responses: Array<{
  ok?: boolean;
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      headers: { get: (h: string) => r.headers?.[h.toLowerCase()] ?? null },
      json: async () => r.json,
      text: async () => '',
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const client = (s: ReturnType<typeof stub>) =>
  new RingClient({ getToken: () => 'tok-123', fetchImpl: s.fetchImpl });

describe('RingClient', () => {
  it('sends the bearer token on every call', async () => {
    const s = stub([{ json: { data: [] } }]);
    await client(s).get('/v1/devices');
    expect((s.calls[0]!.init.headers as Record<string, string>).Authorization)
      .toBe('Bearer tok-123');
  });

  it('turns a Ring error document into a typed error, not a generic throw', async () => {
    const s = stub([{
      ok: false,
      status: 403,
      json: { errors: [{ code: 'REQUEST_FORBIDDEN', detail: 'Cannot authorize: empty request body' }] },
    }]);

    // The real trap from FL-005: a malformed body answers 403 "Cannot authorize",
    // which reads as an auth failure. Keeping code and detail is what lets a
    // caller tell those apart.
    await expect(client(s).get('/v1/devices')).rejects.toMatchObject({
      status: 403,
      code: 'REQUEST_FORBIDDEN',
      detail: 'Cannot authorize: empty request body',
    });
  });

  it('awaits an async token provider', async () => {
    const s = stub([{ json: { data: [] } }]);
    const c = new RingClient({
      getToken: async () => 'from-secrets-manager',
      fetchImpl: s.fetchImpl,
    });
    await c.get('/v1/devices');
    expect((s.calls[0]!.init.headers as Record<string, string>).Authorization)
      .toBe('Bearer from-secrets-manager');
  });
});

describe('postForRedirect', () => {
  it('returns the Location without following it', async () => {
    const s = stub([{
      ok: false,
      status: 303,
      headers: { location: 'https://download-eu-south-2.prod.phoenix.devices.amazon.dev/x' },
    }]);

    await expect(client(s).postForRedirect('/p', {})).resolves
      .toBe('https://download-eu-south-2.prod.phoenix.devices.amazon.dev/x');
    expect(s.calls[0]!.init.redirect).toBe('manual');
    expect(s.calls).toHaveLength(1);  // the bytes were never pulled through us
  });

  it('errors when a success carries no Location', async () => {
    const s = stub([{ ok: true, status: 200, json: {} }]);
    await expect(client(s).postForRedirect('/p', {}))
      .rejects.toMatchObject({ code: 'NO_LOCATION' });
  });

  it('reports the API error when the request itself was rejected', async () => {
    const s = stub([{ ok: false, status: 400, json: { errors: [{ code: 'INVALID_PAYLOAD' }] } }]);
    await expect(client(s).postForRedirect('/p', {}))
      .rejects.toMatchObject({ code: 'INVALID_PAYLOAD', status: 400 });
  });
});

describe('endpoint wrappers', () => {
  it('requests devices with the sideloads the parser needs', async () => {
    const s = stub([{ json: { data: [] } }]);
    await listDevices(client(s));
    expect(s.calls[0]!.url).toContain('include=status,capabilities,location');
  });

  const TWO_EVENTS = { data: [
    { type: 'history-events', id: 'old', attributes: { start: 1000, event_type: 'ding' } },
    { type: 'history-events', id: 'new', attributes: { start: 9000, event_type: 'ding' } },
  ] };

  it('returns history newest first', async () => {
    const events = await listEvents(client(stub([{ json: TWO_EVENTS }])), 'dev-1');
    expect(events.map((e) => e.id)).toEqual(['new', 'old']);
  });

  it('latestEvent picks the newest regardless of the order Ring sent', async () => {
    const latest = await latestEvent(client(stub([{ json: TWO_EVENTS }])), 'dev-1');
    expect(latest?.id).toBe('new');
  });

  it('asks for the frame at the END of the event, not the empty doorstep before it', () => {
    expect(selectorForEvent({ start: 100, end: 900 }))
      .toEqual({ type: 'at_timestamp', timestamp: 900 });
    expect(selectorForEvent({ start: 100 }))
      .toEqual({ type: 'at_timestamp', timestamp: 100 });
  });

  it('posts the undocumented body shape that actually works', async () => {
    const s = stub([{ ok: false, status: 303, headers: { location: 'https://media/x' } }]);
    const image = await imageAt(client(s), 'dev-1', { type: 'at_timestamp', timestamp: 42 }, 100);

    expect(JSON.parse(String(s.calls[0]!.init.body)))
      .toEqual({ type: 'at_timestamp', timestamp: 42 });
    expect(image).toEqual({ url: 'https://media/x', capturedAt: 42, fetchedAt: 100 });
  });
});

describe('RingApiError', () => {
  it('names itself usefully in a log line', () => {
    expect(new RingApiError(403, 'REQUEST_FORBIDDEN', 'x').message)
      .toBe('ring_api_403_REQUEST_FORBIDDEN');
  });
});

describe('fetchImageBytes', () => {
  const image = { url: 'https://media/x', capturedAt: 1, fetchedAt: 2 };

  const bodyStub = (status: number, ok: boolean, bytes: Uint8Array) =>
    (async () => ({
      ok,
      status,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    })) as unknown as typeof fetch;

  it('returns the bytes of a real JPEG', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    await expect(fetchImageBytes(image, bodyStub(200, true, jpeg))).resolves.toEqual(jpeg);
  });

  it('accepts a PNG too', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]);
    await expect(fetchImageBytes(image, bodyStub(200, true, png))).resolves.toEqual(png);
  });

  it('refuses the 422 error body the media host really returns', async () => {
    // Observed live, written to disk as a 201-byte ".jpg" before this check.
    const err = new TextEncoder().encode(JSON.stringify({
      errors: [{ status: '422', code: 'GRECO_NO_VALID_KEY',
                 detail: 'No valid Greco key available for decryption' }],
    }));
    await expect(fetchImageBytes(image, bodyStub(422, false, err))).rejects.toMatchObject({
      status: 422,
      code: 'GRECO_NO_VALID_KEY',
    });
  });

  it('refuses non-image bytes even on a 200', async () => {
    const junk = new TextEncoder().encode('not an image at all');
    await expect(fetchImageBytes(image, bodyStub(200, true, junk)))
      .rejects.toMatchObject({ code: 'NOT_AN_IMAGE' });
  });
});

describe('imageForEvent', () => {
  const event = { start: 100, end: 900 };
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);

  /** Fails the first `failures` attempts with GRECO, then serves a JPEG. */
  function flaky(failures: number) {
    let seen = 0;
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (init.method === 'POST') {
        return { ok: false, status: 303,
                 headers: { get: (h: string) => (h.toLowerCase() === 'location' ? 'https://media/x' : null) },
                 json: async () => ({}), text: async () => '' };
      }
      seen++;
      if (seen <= failures) {
        const body = new TextEncoder().encode(JSON.stringify({
          errors: [{ status: '422', code: 'GRECO_NO_VALID_KEY', detail: 'no key' }],
        }));
        return { ok: false, status: 422, arrayBuffer: async () => body.buffer };
      }
      return { ok: true, status: 200, arrayBuffer: async () => jpeg.buffer };
    }) as unknown as typeof fetch;

    return new RingClient({ getToken: () => 't', fetchImpl });
  }

  const noSleep = { sleep: async () => {}, now: () => 0 };

  it('succeeds first time when the key is already there', async () => {
    const r = await imageForEvent(flaky(0), 'dev', event, noSleep);
    expect(r.attempts).toBe(1);
    expect(r.bytes).toEqual(jpeg);
  });

  it('waits out the key-propagation failure and gets the frame', async () => {
    const r = await imageForEvent(flaky(2), 'dev', event, noSleep);
    expect(r.attempts).toBe(3);
    expect(r.bytes).toEqual(jpeg);
  });

  it('gives up after the attempt budget rather than looping', async () => {
    await expect(imageForEvent(flaky(99), 'dev', event, { ...noSleep, attempts: 3 }))
      .rejects.toMatchObject({ code: 'GRECO_NO_VALID_KEY' });
  });

  it('does not retry a failure that will never fix itself', async () => {
    let bodyFetches = 0;
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (init.method === 'POST') {
        return { ok: false, status: 401, headers: { get: () => null },
                 json: async () => ({ errors: [{ code: 'UNAUTHORIZED' }] }), text: async () => '' };
      }
      bodyFetches++;
      return { ok: true, status: 200, arrayBuffer: async () => jpeg.buffer };
    }) as unknown as typeof fetch;

    const client = new RingClient({ getToken: () => 't', fetchImpl });
    await expect(imageForEvent(client, 'dev', event, noSleep)).rejects.toMatchObject({ status: 401 });
    expect(bodyFetches).toBe(0);
  });
});
