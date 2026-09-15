import { describe, it, expect } from 'vitest';
import { unwrap, parseDevice, parseHistoryEvent } from '../jsonapi.js';

/**
 * Fixtures are the real payloads, reduced and de-identified. Recording what the
 * API actually returns is the point: every shape here was wrong in our first
 * guess, because the docs list paths and not schemas.
 */
const DEVICE_RESPONSE = {
  data: [
    {
      type: 'devices',
      id: 'ava1.ring.device.ABNJQ',
      attributes: { name: 'Playground Device', image_url: 'https://example/x.png' },
      relationships: {
        status: { data: { type: 'device-status', id: 'ava1.ring.device.status.OBZY' } },
        capabilities: {
          data: { type: 'device-capabilities', id: 'ava1.ring.device.capabilities.DBAA' },
        },
      },
    },
  ],
  included: [
    {
      type: 'device-status',
      id: 'ava1.ring.device.status.OBZY',
      attributes: { online: true, reported_at: '2026-09-15T06:46:36Z', state: null },
    },
    {
      type: 'device-capabilities',
      id: 'ava1.ring.device.capabilities.DBAA',
      attributes: {
        motion_detection: { configurations: ['enabled', 'motion_zones'] },
        video: { codecs: ['AVC'], max_resolution: 1080 },
        image_enhancements: { configurations: ['color_night_vision', 'snapshot'] },
        // The live device reports exactly this: present, but null throughout.
        audio: { customizable_slots: null, supported_actions: null },
        battery_status: null,
      },
    },
  ],
  meta: { time: '2026-09-15T06:50:24Z' },
};

describe('unwrap', () => {
  it('returns data as an array and an (type,id) index of included', () => {
    const { items, included } = unwrap(DEVICE_RESPONSE);

    expect(items).toHaveLength(1);
    expect(included.get('device-status:ava1.ring.device.status.OBZY')?.online).toBe(true);
  });

  it('treats a single data object as a one-item list', () => {
    const { items } = unwrap({ data: { type: 'users', id: 'ava1.ring.account.X' } });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('ava1.ring.account.X');
  });

  it('survives a response with no included block', () => {
    const { items, included } = unwrap({ data: [] });
    expect(items).toEqual([]);
    expect(included.size).toBe(0);
  });
});

describe('parseDevice', () => {
  const { items, included } = unwrap(DEVICE_RESPONSE);
  const device = parseDevice(items[0]!, included);

  it('reads identity and status through the relationship sideload', () => {
    expect(device.id).toBe('ava1.ring.device.ABNJQ');
    expect(device.name).toBe('Playground Device');
    expect(device.online).toBe(true);
    expect(device.reportedAt).toBe(Date.parse('2026-09-15T06:46:36Z'));
  });

  it('reads motion and image capabilities', () => {
    expect(device.capabilities.motion).toBe(true);
    expect(device.capabilities.image).toBe(true);
    expect(device.capabilities.maxResolution).toBe(1080);
  });

  it('reports NO chime when supported_actions is null — the live case', () => {
    // This is the fact that removes a button from the Door Card. If this test
    // ever flips silently, the card starts offering an action that 400s.
    expect(device.capabilities.chime).toBe(false);
  });

  it('reports a chime when the device actually lists audio actions', () => {
    const withChime = structuredClone(DEVICE_RESPONSE);
    (withChime.included[1]!.attributes as Record<string, unknown>).audio = {
      supported_actions: ['play_sound'],
      customizable_slots: 2,
    };
    const parsed = unwrap(withChime);
    expect(parseDevice(parsed.items[0]!, parsed.included).capabilities.chime).toBe(true);
  });

  it('does not invent a name for a device that has none', () => {
    const nameless = { type: 'devices', id: 'ava1.ring.device.Q', attributes: {} };
    expect(parseDevice(nameless, new Map()).name).toBe('');
  });
});

describe('parseHistoryEvent', () => {
  const EVENT = {
    type: 'history-events',
    id: 'ava1.ring.history.event.XWRR',
    attributes: {
      start: 1789455093305,
      end: 1789455104824,
      event_type: 'on_demand',
      is_third_party_reviewed: true,
    },
    relationships: { cv_detections: { data: [] } },
  };

  it('parses the window and the event type', () => {
    const e = parseHistoryEvent(EVENT, 'ava1.ring.device.ABNJQ');
    expect(e.start).toBe(1789455093305);
    expect(e.end).toBe(1789455104824);
    expect(e.eventType).toBe('on_demand');
    expect(e.detections).toEqual([]);
  });

  it('collects cv_detection ids when Ring reports any', () => {
    const withDetections = structuredClone(EVENT);
    withDetections.relationships.cv_detections.data = [
      { type: 'cv-detections', id: 'human' },
    ] as never;
    expect(parseHistoryEvent(withDetections, 'd').detections).toEqual(['human']);
  });

  it('tolerates a missing end, because an open event is still an event', () => {
    const open = structuredClone(EVENT);
    delete (open.attributes as Record<string, unknown>).end;
    expect(parseHistoryEvent(open, 'd').end).toBeUndefined();
  });
});
