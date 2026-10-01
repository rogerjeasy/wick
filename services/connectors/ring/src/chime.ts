/**
 * M1 — the hallway chime. Ring docs: Chimes (Early Access), verified 2026-10-01.
 *
 *   GET  /v1/devices/{id}/status          online, audio.snooze.active
 *   GET  /v1/devices/{id}/configurations  audio.customizable_slots[] (the app's slots)
 *   POST /v1/devices/{id}/media/audio/playback
 *        { data: { type: 'audio', attributes: { audio_ref } } } → 200 { status: 'completed' }
 *
 * A chime is an indoor speaker, so this tells the house, not the visitor
 * (spec D1). Playback makes a sound in someone's home: it is only ever called
 * from an explicit button press, exactly once, never retried (Ring best
 * practice #6, spec D4).
 */
import { RingApiError, type RingClient } from './client.js';
import { parseChimeSlots, parsePlaybackStatus } from './jsonapi.js';
import type { ChimeOutcome, RingDevice } from './types.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Chimes Wick may sound right now, as far as the (possibly cached) list knows. */
export function playableChimes(devices: readonly RingDevice[]): RingDevice[] {
  return devices.filter((d) => d.capabilities.chime && d.online && d.snoozed !== true);
}

/** Phase 1's question: is the button worth drawing? */
export function hasHallwayChime(devices: readonly RingDevice[]): boolean {
  return playableChimes(devices).length > 0;
}

async function readStatus(client: RingClient, chimeId: string): Promise<{ online: boolean; snoozed: boolean }> {
  const doc = await client.get(`/v1/devices/${chimeId}/status`);
  const data = isRecord(doc) && isRecord(doc.data) ? doc.data : {};
  const attrs = isRecord(data.attributes) ? data.attributes : {};
  const audio = isRecord(attrs.audio) ? attrs.audio : {};
  const snooze = isRecord(audio.snooze) ? audio.snooze : {};
  return { online: attrs.online === true, snoozed: snooze.active === true };
}

/**
 * Play one chime's slot audio. Re-reads status first: the list Phase 1 used
 * can be a minute old, and a chime snoozed since then must stay quiet.
 */
export async function ringChime(client: RingClient, chimeId: string, slotEvent: string): Promise<ChimeOutcome> {
  let status: { online: boolean; snoozed: boolean };
  try {
    status = await readStatus(client, chimeId);
  } catch (err) {
    // A chime Ring can't report on is, for the resident, a chime that didn't answer.
    if (err instanceof RingApiError) return 'offline';
    throw err;
  }
  if (!status.online) return 'offline';
  if (status.snoozed) return 'snoozed';

  try {
    const slots = parseChimeSlots(await client.get(`/v1/devices/${chimeId}/configurations`)).filter((s) => !s.disabled);
    const slot = slots.find((s) => s.event === slotEvent) ?? slots[0];
    if (!slot) return 'no_audio';

    const played = await client.post(`/v1/devices/${chimeId}/media/audio/playback`, {
      data: { type: 'audio', attributes: { audio_ref: slot.audioRef } },
    });
    return parsePlaybackStatus(played) === 'completed' ? 'rang' : 'failed';
  } catch (err) {
    if (err instanceof RingApiError) return 'failed';
    throw err;
  }
}

/** Precedence: the most useful true thing to tell the resident. */
const ORDER: readonly ChimeOutcome[] = ['rang', 'snoozed', 'no_audio', 'offline', 'failed'];

export function summariseChimeOutcomes(outcomes: readonly ChimeOutcome[]): ChimeOutcome | 'no_chime' {
  if (outcomes.length === 0) return 'no_chime';
  return ORDER.find((o) => outcomes.includes(o)) ?? 'failed';
}
