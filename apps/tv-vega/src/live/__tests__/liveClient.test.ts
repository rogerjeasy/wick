import { describe, it, expect, vi } from 'vitest';
import { liveMessage, outcomeWhenPlayerStops, secondsLeft, startLiveSession, stopLiveSession, waitForPlaylist } from '../liveClient.js';

const API = 'https://api.example';
const TOKEN = 'jwt-abc';

const res = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }) as Response;

describe('startLiveSession', () => {
  it('POSTs the card id with the device token and returns the session', async () => {
    const session = { sessionId: 's1', playlistUrl: 'https://live/s1/live.m3u8', endsAt: 99 };
    const fetchImpl = vi.fn(async () => res(201, session));

    const out = await startLiveSession({ pairingApiUrl: API, jwt: TOKEN, cardId: 'door-abc', fetchImpl });

    expect(out).toEqual({ ok: true, session });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/live/sessions`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({ cardId: 'door-abc' });
  });

  it('turns each refusal into a reason the view can say', async () => {
    const cases: [number, unknown, string][] = [
      [503, { error: 'camera_unavailable' }, 'camera_unavailable'],
      [410, { error: 'card_too_old' }, 'card_too_old'],
      [422, { error: 'camera_unsupported' }, 'camera_unsupported'],
      [404, { error: 'no_such_card' }, 'no_such_card'],
      [401, { error: 'unauthorized' }, 'unauthorized'],
      [500, 'boom', 'camera_unavailable'],
    ];
    for (const [status, body, reason] of cases) {
      expect(await startLiveSession({ pairingApiUrl: API, jwt: TOKEN, cardId: 'c', fetchImpl: vi.fn(async () => res(status, body)) }))
        .toEqual({ ok: false, reason });
    }
  });

  it('counts down on the television\'s own clock: one 7 hours wrong still shows the 60 seconds Ring gives', async () => {
    const serverNow = Date.UTC(2026, 9, 1, 8, 34, 46);
    const tvNow = serverNow - 24_875_000;
    const reply = res(201, { sessionId: 's1', playlistUrl: 'https://live/s1/live.m3u8', endsAt: serverNow + 60_000 });
    Object.assign(reply, { headers: new Headers({ Date: new Date(serverNow).toUTCString() }) });

    const out = await startLiveSession({ pairingApiUrl: API, jwt: TOKEN, cardId: 'c', fetchImpl: vi.fn(async () => reply), now: () => tvNow });

    expect(out.ok && secondsLeft(out.session.endsAt, tvNow)).toBe(60);
  });

  it('treats no network as the camera not answering — never a hang', async () => {
    const out = await startLiveSession({ pairingApiUrl: API, jwt: TOKEN, cardId: 'c', fetchImpl: vi.fn(async () => { throw new TypeError('Network request failed'); }) });
    expect(out).toEqual({ ok: false, reason: 'camera_unavailable' });
  });
});

describe('stopLiveSession', () => {
  it('DELETEs the session and never throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    await expect(stopLiveSession({ pairingApiUrl: API, jwt: TOKEN, sessionId: 's1', fetchImpl })).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/live/sessions/s1`);
    expect(init.method).toBe('DELETE');
  });
});

describe('waitForPlaylist — the bridge needs ~6s for its first playlist', () => {
  it('polls until the playlist names a segment', async () => {
    let t = 0;
    const replies = [res(404), res(403), res(200, '#EXTM3U\n'), res(200, '#EXTM3U\n#EXTINF:1.0,\nlive0.ts\n')];
    const fetchImpl = vi.fn(async () => replies.shift()!);

    const ready = await waitForPlaylist({ url: 'https://live/s1/live.m3u8', fetchImpl, timeoutMs: 12_000, now: () => t, sleep: async (ms) => { t += ms; } });

    expect(ready).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('gives up at the timeout, so the view can say the camera isn\'t answering', async () => {
    let t = 0;
    const ready = await waitForPlaylist({ url: 'u', fetchImpl: vi.fn(async () => res(404)), timeoutMs: 12_000, now: () => t, sleep: async (ms) => { t += ms; } });
    expect(ready).toBe(false);
  });

  it('stops polling when cancelled', async () => {
    let t = 0;
    let cancelled = false;
    const fetchImpl = vi.fn(async () => { cancelled = true; return res(404); });
    const ready = await waitForPlaylist({ url: 'u', fetchImpl, timeoutMs: 12_000, now: () => t, sleep: async (ms) => { t += ms; }, cancelled: () => cancelled });
    expect(ready).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('liveMessage — say plainly what happened (D6)', () => {
  it('has one sentence for each outcome, none of them a code', () => {
    expect(liveMessage('camera_unavailable')).toBe("The doorbell camera isn't answering right now.");
    expect(liveMessage('ended')).toBe('Live view has ended.');
    for (const r of ['card_too_old', 'camera_unsupported', 'no_such_card', 'unauthorized'] as const) {
      expect(liveMessage(r)).toMatch(/^[A-Z][^_]*\.$/);
    }
  });
});

describe('secondsLeft', () => {
  it('counts down in whole seconds and never below zero', () => {
    expect(secondsLeft(10_000, 0)).toBe(10);
    expect(secondsLeft(10_000, 9_001)).toBe(1);
    expect(secondsLeft(10_000, 12_000)).toBe(0);
  });
});

describe('outcomeWhenPlayerStops — what the resident is told when the picture stops', () => {
  it('says the view has ended once there was a picture — Ring closes the stream on its own', () => {
    // Seen on the VVD: after ~40s of picture the Playground stream ended and
    // the view said "The doorbell camera isn't answering right now."
    expect(liveMessage(outcomeWhenPlayerStops({ hadPicture: true }))).toBe('Live view has ended.');
  });

  it('says the camera is not answering when no picture ever came', () => {
    expect(outcomeWhenPlayerStops({ hadPicture: false })).toBe('camera_unavailable');
  });
});

describe('liveMessage — in the language she chose', () => {
  it('says every outcome in Spanish, one plain sentence each', () => {
    expect(liveMessage('camera_unavailable', 'es')).toBe('La cámara del timbre no responde ahora.');
    expect(liveMessage('camera_unsupported', 'es')).toBe('La cámara de este timbre aún no se puede ver en el televisor.');
    expect(liveMessage('card_too_old', 'es')).toBe('Esa visita fue hace un rato; ya no hay nada en vivo que mostrar.');
    expect(liveMessage('no_such_card', 'es')).toBe('No hay imagen en vivo de esa visita.');
    expect(liveMessage('unauthorized', 'es')).toBe('Hay que volver a vincular el televisor para ver la cámara.');
    expect(liveMessage('ended', 'es')).toBe('La vista en vivo terminó.');
  });

  it('never shows a code: an outcome it has no sentence for is said as the camera not answering', () => {
    expect(liveMessage('something_new' as never)).toBe("The doorbell camera isn't answering right now.");
    expect(liveMessage('something_new' as never, 'es')).toBe('La cámara del timbre no responde ahora.');
  });
});
