import { describe, it, expect } from 'vitest';
import { RingApiError, RingClient } from '../client.js';
import { startWhepSession, stopWhepSession } from '../whep.js';

type Reply = { status: number; text?: string; json?: unknown; headers?: Record<string, string> };

function ring(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (h: string) => r.headers?.[h.toLowerCase()] ?? null },
      json: async () => r.json,
      text: async () => r.text ?? JSON.stringify(r.json ?? ''),
    };
  }) as unknown as typeof fetch;
  return { client: new RingClient({ getToken: () => 'tok', fetchImpl }), calls };
}

const SESSION_URL = 'https://api.amazonvision.com/v1/devices/cam-1/media/streaming/whep/sessions/zzz';

describe('startWhepSession — Ring docs, WHEP Live Video Streaming', () => {
  it('POSTs the SDP offer as application/sdp and returns the answer and the session URL', async () => {
    const r = ring([{ status: 201, text: 'v=0 answer', headers: { location: SESSION_URL } }]);

    const session = await startWhepSession(r.client, 'cam-1', 'v=0 offer');

    expect(session).toEqual({ answer: 'v=0 answer', sessionUrl: SESSION_URL });
    expect(r.calls[0]!.url).toBe('https://api.amazonvision.com/v1/devices/cam-1/media/streaming/whep/sessions');
    expect(r.calls[0]!.init.method).toBe('POST');
    expect((r.calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/sdp');
    expect(r.calls[0]!.init.body).toBe('v=0 offer');
  });

  it('turns a 503 (camera offline) into a typed error', async () => {
    const r = ring([{ status: 503, json: { errors: [{ status: '503', title: 'Device Unavailable' }] } }]);
    await expect(startWhepSession(r.client, 'cam-1', 'o')).rejects.toMatchObject({ status: 503 });
  });

  it('keeps the HEVC-only code, so the caller can say the camera is not supported', async () => {
    const r = ring([{ status: 400, json: { errors: [{ code: 'UNSUPPORTED_HEVC_SDP_OFFER', status: '400' }] } }]);
    await expect(startWhepSession(r.client, 'cam-1', 'o')).rejects.toMatchObject({ code: 'UNSUPPORTED_HEVC_SDP_OFFER' });
  });

  it('refuses a 201 without a Location — the session could never be closed', async () => {
    const r = ring([{ status: 201, text: 'v=0' }]);
    await expect(startWhepSession(r.client, 'cam-1', 'o')).rejects.toBeInstanceOf(RingApiError);
  });
});

describe('stopWhepSession', () => {
  it('DELETEs the session URL Ring gave us, with the bearer token', async () => {
    const r = ring([{ status: 204 }]);
    await stopWhepSession(r.client, SESSION_URL);
    expect(r.calls[0]!.url).toBe(SESSION_URL);
    expect(r.calls[0]!.init.method).toBe('DELETE');
    expect((r.calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('refuses to send the token anywhere but Ring\'s API host', async () => {
    const r = ring([{ status: 204 }]);
    await expect(stopWhepSession(r.client, 'https://evil.example/v1/x')).rejects.toThrow('foreign_session_url');
    expect(r.calls).toHaveLength(0);
  });

  it('treats an already-ended session (404) as stopped', async () => {
    const r = ring([{ status: 404, json: { errors: [{ status: '404' }] } }]);
    await expect(stopWhepSession(r.client, SESSION_URL)).resolves.toBeUndefined();
  });
});
