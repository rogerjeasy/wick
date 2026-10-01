import { describe, it, expect } from 'vitest';
import { RingClient } from '../client.js';
import { hasHallwayChime, playableChimes, ringChime, summariseChimeOutcomes } from '../chime.js';
import type { RingDevice } from '../types.js';

type Reply = { status?: number; json?: unknown };

/** Routes by path suffix; records every call. */
function ring(routes: Record<string, Reply>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    if (!key) throw new Error(`unexpected ${url}`);
    const r = routes[key]!;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => r.json,
      text: async () => '',
    };
  }) as unknown as typeof fetch;
  return { client: new RingClient({ getToken: () => 'tok', fetchImpl }), calls };
}

const STATUS = (online: boolean, snoozed: boolean): Reply => ({
  json: { data: { type: 'device-status', attributes: { online, audio: { snooze: { active: snoozed, until: null } } } } },
});
const CONFIG: Reply = {
  json: {
    data: {
      attributes: {
        audio: {
          customizable_slots: [
            { event: 'ring-appstore-event-2', disabled: false, audio_ref: 'ref-2', audio_name: 'B' },
            { event: 'ring-appstore-event-1', disabled: false, audio_ref: 'ref-1', audio_name: 'A' },
          ],
        },
      },
    },
  },
};
const PLAYED: Reply = { json: { data: { type: 'audio', id: 'ref-1', attributes: { status: 'completed' } } } };

const dev = (id: string, over: { chime?: boolean; online?: boolean; snoozed?: boolean } = {}): RingDevice => ({
  id,
  name: id,
  online: over.online ?? true,
  ...(over.snoozed ? { snoozed: true } : {}),
  capabilities: { motion: false, image: false, chime: over.chime ?? true },
});

describe('playableChimes / hasHallwayChime', () => {
  it('keeps only online, unsnoozed chimes', () => {
    const devices = [dev('cam', { chime: false }), dev('c1'), dev('c2', { online: false }), dev('c3', { snoozed: true })];
    expect(playableChimes(devices).map((d) => d.id)).toEqual(['c1']);
    expect(hasHallwayChime(devices)).toBe(true);
  });

  it('is false for the Playground account — one camera, no chime', () => {
    expect(hasHallwayChime([dev('cam', { chime: false })])).toBe(false);
  });
});

describe('ringChime', () => {
  it('re-reads status, takes the configured slot, and posts the documented JSON:API body', async () => {
    const r = ring({ '/c1/status': STATUS(true, false), '/c1/configurations': CONFIG, '/c1/media/audio/playback': PLAYED });

    expect(await ringChime(r.client, 'c1', 'ring-appstore-event-1')).toBe('rang');

    const post = r.calls.find((c) => c.url.endsWith('/media/audio/playback'))!;
    expect(post.init.method).toBe('POST');
    expect(JSON.parse(post.init.body as string)).toEqual({ data: { type: 'audio', attributes: { audio_ref: 'ref-1' } } });
  });

  it('never plays a chime that was snoozed after the card went out', async () => {
    const r = ring({ '/c1/status': STATUS(true, true) });
    expect(await ringChime(r.client, 'c1', 'ring-appstore-event-1')).toBe('snoozed');
    expect(r.calls.some((c) => c.url.includes('playback'))).toBe(false);
  });

  it('reports offline without calling playback', async () => {
    const r = ring({ '/c1/status': STATUS(false, false) });
    expect(await ringChime(r.client, 'c1', 'ring-appstore-event-1')).toBe('offline');
    expect(r.calls.some((c) => c.url.includes('playback'))).toBe(false);
  });

  it('falls back to the first enabled slot when the configured one is missing', async () => {
    const r = ring({ '/c1/status': STATUS(true, false), '/c1/configurations': CONFIG, '/c1/media/audio/playback': PLAYED });
    await ringChime(r.client, 'c1', 'ring-appstore-event-9');
    const post = r.calls.find((c) => c.url.endsWith('/media/audio/playback'))!;
    expect(JSON.parse(post.init.body as string).data.attributes.audio_ref).toBe('ref-1');
  });

  it('skips a disabled slot even when it is the configured one', async () => {
    const disabled = structuredClone(CONFIG);
    ((disabled.json as { data: { attributes: { audio: { customizable_slots: Record<string, unknown>[] } } } })
      .data.attributes.audio.customizable_slots[1]!).disabled = true;
    const r = ring({ '/c1/status': STATUS(true, false), '/c1/configurations': disabled, '/c1/media/audio/playback': PLAYED });
    await ringChime(r.client, 'c1', 'ring-appstore-event-1');
    const post = r.calls.find((c) => c.url.endsWith('/media/audio/playback'))!;
    expect(JSON.parse(post.init.body as string).data.attributes.audio_ref).toBe('ref-2');
  });

  it('reports no_audio when the chime has no enabled slot', async () => {
    const r = ring({ '/c1/status': STATUS(true, false), '/c1/configurations': { json: { data: { attributes: { audio: { customizable_slots: [] } } } } } });
    expect(await ringChime(r.client, 'c1', 'ring-appstore-event-1')).toBe('no_audio');
  });

  it('reports failed — not rang — when Ring answers 200 without status "completed"', async () => {
    const r = ring({
      '/c1/status': STATUS(true, false),
      '/c1/configurations': CONFIG,
      '/c1/media/audio/playback': { json: { data: { attributes: { status: 'queued' } } } },
    });
    expect(await ringChime(r.client, 'c1', 'ring-appstore-event-1')).toBe('failed');
  });

  it('reports failed on an API error, and calls playback exactly once — no retry', async () => {
    const r = ring({
      '/c1/status': STATUS(true, false),
      '/c1/configurations': CONFIG,
      '/c1/media/audio/playback': { status: 403, json: { errors: [{ code: 'FORBIDDEN' }] } },
    });
    expect(await ringChime(r.client, 'c1', 'ring-appstore-event-1')).toBe('failed');
    expect(r.calls.filter((c) => c.url.endsWith('/media/audio/playback'))).toHaveLength(1);
  });

  it('reports offline when the status read itself fails', async () => {
    const r = ring({ '/c1/status': { status: 404, json: { errors: [{ code: 'NOT_FOUND' }] } } });
    expect(await ringChime(r.client, 'c1', 'ring-appstore-event-1')).toBe('offline');
  });
});

describe('summariseChimeOutcomes', () => {
  it('rang if any chime rang — two chimes, one offline', () => {
    expect(summariseChimeOutcomes(['offline', 'rang'])).toBe('rang');
  });

  it('snoozed beats no_audio beats offline beats failed', () => {
    expect(summariseChimeOutcomes(['failed', 'snoozed'])).toBe('snoozed');
    expect(summariseChimeOutcomes(['offline', 'no_audio'])).toBe('no_audio');
    expect(summariseChimeOutcomes(['failed', 'offline'])).toBe('offline');
  });

  it('no_chime for an empty list', () => {
    expect(summariseChimeOutcomes([])).toBe('no_chime');
  });
});
