/**
 * JSON:API decoding for the Ring Partner API.
 *
 * Pure — no fetch, no credentials. Everything here was written against captured
 * live responses, because the API reference documents paths and not schemas
 * (FL-005). Keep it that way: if a shape surprises you, add the real payload to
 * the tests rather than a guess to the parser.
 */
import type { ChimeSlot, RingCapabilities, RingDevice, RingHistoryEvent } from './types.js';

export interface Resource {
  readonly type?: string;
  readonly id: string;
  readonly attributes?: Record<string, unknown>;
  readonly relationships?: Record<string, { data?: unknown }>;
}

/** Key into the sideload index. */
const key = (type: string, id: string) => `${type}:${id}`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/**
 * Split a JSON:API document into its primary resources and an index of the
 * sideloaded ones, so a relationship can be resolved without a second request.
 */
export function unwrap(doc: unknown): {
  items: Resource[];
  included: Map<string, Record<string, unknown>>;
} {
  const included = new Map<string, Record<string, unknown>>();
  if (!isRecord(doc)) return { items: [], included };

  for (const inc of Array.isArray(doc.included) ? doc.included : []) {
    if (isRecord(inc) && typeof inc.type === 'string' && typeof inc.id === 'string') {
      included.set(key(inc.type, inc.id), isRecord(inc.attributes) ? inc.attributes : {});
    }
  }

  const data = doc.data;
  const items = (Array.isArray(data) ? data : data == null ? [] : [data]).filter(
    (x): x is Resource => isRecord(x) && typeof x.id === 'string',
  );

  return { items, included };
}

/** Resolve a named relationship through the sideload index. */
function related(
  res: Resource,
  name: string,
  included: Map<string, Record<string, unknown>>,
): Record<string, unknown> {
  const ref = res.relationships?.[name]?.data;
  if (!isRecord(ref) || typeof ref.type !== 'string' || typeof ref.id !== 'string') return {};
  return included.get(key(ref.type, ref.id)) ?? {};
}

function parseCapabilities(caps: Record<string, unknown>): RingCapabilities {
  const video = isRecord(caps.video) ? caps.video : {};
  const audio = isRecord(caps.audio) ? caps.audio : {};
  const image = isRecord(caps.image_enhancements) ? caps.image_enhancements : {};

  const actions = audio.supported_actions;
  const maxRes = video.max_resolution;

  return {
    motion: isRecord(caps.motion_detection),
    image: Array.isArray(image.configurations) && image.configurations.includes('snapshot'),
    // Ring docs, Chimes: a chime is the device whose audio.supported_actions
    // includes chime.play. A present-but-null block is the Playground camera
    // (FL-006); some other action name is not something we know how to play.
    chime: Array.isArray(actions) && actions.includes('chime.play'),
    ...(typeof maxRes === 'number' ? { maxResolution: maxRes } : {}),
  };
}

export function parseDevice(
  res: Resource,
  included: Map<string, Record<string, unknown>>,
): RingDevice {
  const attrs = res.attributes ?? {};
  const status = related(res, 'status', included);
  const caps = related(res, 'capabilities', included);

  const reportedAt =
    typeof status.reported_at === 'string' ? Date.parse(status.reported_at) : NaN;
  const audio = isRecord(status.audio) ? status.audio : {};
  const snooze = isRecord(audio.snooze) ? audio.snooze : {};

  return {
    id: res.id,
    // Never substitute a friendly default. An unnamed device is a fact worth
    // seeing, not one to paper over. ("When unsure, say so.")
    name: typeof attrs.name === 'string' ? attrs.name : '',
    online: status.online === true,
    ...(Number.isFinite(reportedAt) ? { reportedAt } : {}),
    ...(snooze.active === true ? { snoozed: true } : {}),
    capabilities: parseCapabilities(caps),
  };
}

export function parseHistoryEvent(res: Resource, deviceId: string): RingHistoryEvent {
  const attrs = res.attributes ?? {};
  const detections = res.relationships?.cv_detections?.data;

  const end = attrs.end;

  return {
    id: res.id,
    deviceId,
    start: typeof attrs.start === 'number' ? attrs.start : 0,
    ...(typeof end === 'number' ? { end } : {}),
    eventType: typeof attrs.event_type === 'string' ? attrs.event_type : 'unknown',
    detections: (Array.isArray(detections) ? detections : [])
      .filter(isRecord)
      .map((d) => String(d.id)),
  };
}

/** `GET /v1/devices/{id}/configurations` → the chime's slots, sorted by event (Ring does not sort). */
export function parseChimeSlots(doc: unknown): ChimeSlot[] {
  const data = isRecord(doc) && isRecord(doc.data) ? doc.data : {};
  const attrs = isRecord(data.attributes) ? data.attributes : {};
  const audio = isRecord(attrs.audio) ? attrs.audio : {};
  const slots = Array.isArray(audio.customizable_slots) ? audio.customizable_slots : [];

  return slots
    .filter(isRecord)
    .filter((s) => typeof s.event === 'string' && typeof s.audio_ref === 'string' && s.audio_ref !== '')
    .map((s) => ({
      event: s.event as string,
      disabled: s.disabled === true,
      audioRef: s.audio_ref as string,
      audioName: typeof s.audio_name === 'string' ? s.audio_name : '',
    }))
    .sort((a, b) => a.event.localeCompare(b.event));
}

/** `POST …/media/audio/playback` → `data.attributes.status` ("completed" means it played). */
export function parsePlaybackStatus(doc: unknown): string | null {
  const data = isRecord(doc) && isRecord(doc.data) ? doc.data : {};
  const attrs = isRecord(data.attributes) ? data.attributes : {};
  return typeof attrs.status === 'string' ? attrs.status : null;
}
