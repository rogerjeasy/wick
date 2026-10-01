import { describe, it, expect, vi } from 'vitest';
import { handleLiveHttp, type LiveHttpDeps, type HttpEvent } from '../lambda.js';

const claims = { deviceId: 'wick-tv', householdId: 'margaret' };

function deps(over: Partial<LiveHttpDeps> = {}): LiveHttpDeps {
  return {
    verify: vi.fn(async (token: string) => {
      if (token !== 'good') throw new Error('bad_signature');
      return claims;
    }),
    deviceAllowed: vi.fn(async () => true),
    invoke: vi.fn(async () => ({ sessionId: 's1', playlistUrl: 'https://live/x.m3u8', endsAt: 5 })),
    ...over,
  };
}

const post = (body: unknown, auth = 'Bearer good'): HttpEvent => ({
  requestContext: { http: { method: 'POST' } },
  rawPath: '/live/sessions',
  headers: auth ? { authorization: auth } : {},
  body: JSON.stringify(body),
});

const del = (id: string, auth = 'Bearer good'): HttpEvent => ({
  requestContext: { http: { method: 'DELETE' } },
  rawPath: `/live/sessions/${id}`,
  headers: { authorization: auth },
  pathParameters: { sessionId: id },
});

describe('POST /live/sessions', () => {
  it('starts a live session for the token\'s household and answers 201', async () => {
    const d = deps();
    const res = await handleLiveHttp(post({ cardId: 'door-abc' }), d);

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ sessionId: 's1', playlistUrl: 'https://live/x.m3u8', endsAt: 5 });
    expect(d.invoke).toHaveBeenCalledWith('live.start', 'margaret', { cardId: 'door-abc' });
  });

  it('401s without a valid device token, and never reaches the agent plane', async () => {
    for (const auth of ['', 'Bearer bad', 'Basic good']) {
      const d = deps();
      expect((await handleLiveHttp(post({ cardId: 'door-abc' }, auth), d)).statusCode).toBe(401);
      expect(d.invoke).not.toHaveBeenCalled();
    }
  });

  it('403s a revoked device', async () => {
    const d = deps({ deviceAllowed: vi.fn(async () => false) });
    expect((await handleLiveHttp(post({ cardId: 'door-abc' }), d)).statusCode).toBe(403);
    expect(d.invoke).not.toHaveBeenCalled();
  });

  it('400s a body without a card id', async () => {
    expect((await handleLiveHttp(post({}), deps())).statusCode).toBe(400);
    expect((await handleLiveHttp({ ...post({}), body: '{nope' }, deps())).statusCode).toBe(400);
  });

  it('maps each refusal to a status the TV can tell apart', async () => {
    const cases: [string, number][] = [['no_such_card', 404], ['card_too_old', 410], ['camera_unavailable', 503], ['camera_unsupported', 422]];
    for (const [error, status] of cases) {
      const res = await handleLiveHttp(post({ cardId: 'door-abc' }), deps({ invoke: vi.fn(async () => ({ error })) }));
      expect(res.statusCode).toBe(status);
      expect(JSON.parse(res.body)).toEqual({ error });
    }
  });

  it('answers 503 camera_unavailable when the agent plane itself is down', async () => {
    const res = await handleLiveHttp(post({ cardId: 'door-abc' }), deps({ invoke: vi.fn(async () => { throw new Error('agentcore_500'); }) }));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'camera_unavailable' });
  });
});

describe('DELETE /live/sessions/{id}', () => {
  it('asks the household session to stop it, and answers 204', async () => {
    const d = deps({ invoke: vi.fn(async () => ({ stopped: true })) });
    const res = await handleLiveHttp(del('s1'), d);
    expect(res.statusCode).toBe(204);
    expect(d.invoke).toHaveBeenCalledWith('live.stop', 'margaret', { sessionId: 's1' });
  });

  it('still answers 204 when the stop could not be delivered — Ring ends it within a minute anyway', async () => {
    const res = await handleLiveHttp(del('s1'), deps({ invoke: vi.fn(async () => { throw new Error('x'); }) }));
    expect(res.statusCode).toBe(204);
  });
});

it('404s any other route', async () => {
  expect((await handleLiveHttp({ ...post({}), rawPath: '/live/other' }, deps())).statusCode).toBe(404);
});
