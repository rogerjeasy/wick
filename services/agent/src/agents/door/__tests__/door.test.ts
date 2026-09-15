import { describe, it, expect } from 'vitest';
import { MAX_CARD_ACTIONS } from '@wick/contracts';
import type { RingDevice, RingHistoryEvent } from '@wick/ring';
import {
  DOOR_LINE,
  buildPhaseOneCard,
  buildImagePatch,
  buildDescriptionPatch,
  validateDescription,
  DESCRIPTION_MAX_WORDS,
  MIN_DESCRIPTION_CONFIDENCE,
} from '../index.js';

const device = (chime: boolean): RingDevice => ({
  id: 'ava1.ring.device.ABNJQ',
  name: 'Front Door',
  online: true,
  capabilities: { motion: true, image: true, chime },
});

const event: RingHistoryEvent = {
  id: 'ava1.ring.history.event.XWRR',
  deviceId: 'ava1.ring.device.ABNJQ',
  start: 1789455093305,
  end: 1789455104824,
  eventType: 'ding',
  detections: [],
};

const build = (chime: boolean) =>
  buildPhaseOneCard({
    event,
    device: device(chime),
    householdId: 'hh-1',
    correlationId: 'corr-abc',
    now: 1789455094000,
  });

describe('buildPhaseOneCard', () => {
  it('says the one plain sentence, and never "motion detected"', () => {
    const card = build(true);
    expect(card.type).toBe('DOOR');
    expect(card.line).toBe(DOOR_LINE);
    expect(card.line).toBe("Someone's at the front door.");
  });

  it('carries the correlationId through, because INV-6 has to survive the card', () => {
    expect(build(true).correlationId).toBe('corr-abc');
  });

  it('ships WITHOUT an image — the image is 3.2s away and the card is due in 900ms', () => {
    // FL-005: measured 3.15s end to end. Blocking Phase 1 on it would miss the
    // budget by 2.5s, so the image is always a patch.
    expect(build(true).imageRef).toBeUndefined();
    expect(build(true).description).toBeUndefined();
  });

  it('offers all three buttons when the device really has a chime', () => {
    const ids = build(true).actions.map((a) => a.id);
    expect(ids).toEqual(['watch_live', 'just_a_moment', 'dismiss']);
  });

  it('drops "Just a moment" when the device has no chime, rather than offering a button that 400s', () => {
    const actions = build(false).actions;
    expect(actions.map((a) => a.id)).toEqual(['watch_live', 'dismiss']);
    expect(actions.some((a) => a.id === 'just_a_moment')).toBe(false);
  });

  it('always keeps a way out, and never exceeds three actions', () => {
    for (const chime of [true, false]) {
      const actions = build(chime).actions;
      expect(actions.length).toBeLessThanOrEqual(MAX_CARD_ACTIONS);
      expect(actions.at(-1)?.kind).toBe('dismiss');
    }
  });

  it('derives a stable id from the event, so a redelivered webhook is the same card', () => {
    expect(build(true).id).toBe(build(true).id);
  });

  it('keeps the id short — Ring event ids are ~100 opaque characters', () => {
    expect(build(true).id.length).toBeLessThanOrEqual(20);
    expect(build(true).id.startsWith('door-')).toBe(true);
  });

  it('gives different events different cards', () => {
    const other = buildPhaseOneCard({
      event: { ...event, id: 'ava1.ring.history.event.OTHER' },
      device: device(true),
      householdId: 'hh-1',
      correlationId: 'corr-abc',
      now: 1789455094000,
    });
    expect(other.id).not.toBe(build(true).id);
  });
});

describe('validateDescription', () => {
  it('accepts the sentence the product is built around', () => {
    expect(validateDescription('A man in a delivery uniform, holding a parcel.')).toBe(true);
  });

  it(`rejects anything over ${DESCRIPTION_MAX_WORDS} words`, () => {
    expect(validateDescription(Array(DESCRIPTION_MAX_WORDS + 1).fill('a').join(' '))).toBe(false);
    expect(validateDescription(Array(DESCRIPTION_MAX_WORDS).fill('a').join(' '))).toBe(true);
  });

  it('rejects more than one sentence', () => {
    expect(validateDescription('A man waits. He holds a parcel.')).toBe(false);
  });

  it('rejects empty and whitespace', () => {
    expect(validateDescription('')).toBe(false);
    expect(validateDescription('   ')).toBe(false);
  });

  it('rejects speculation about intent or mood, which is a product rule not a style note', () => {
    expect(validateDescription('A man who seems angry is waiting.')).toBe(false);
    expect(validateDescription('A man is probably delivering a parcel.')).toBe(false);
    expect(validateDescription('A man appears to be looking for someone.')).toBe(false);
  });
});

describe('buildDescriptionPatch', () => {
  it('patches a valid, confident description onto the card', () => {
    const patch = buildDescriptionPatch('card-1', {
      description: 'A man in a delivery uniform, holding a parcel.',
      confidence: 0.9,
    });
    expect(patch?.description).toBe('A man in a delivery uniform, holding a parcel.');
    expect(patch?.cardId).toBe('card-1');
  });

  it('emits NOTHING on low confidence — Phase 1 stands (Principle 11)', () => {
    expect(
      buildDescriptionPatch('card-1', {
        description: 'A man in a delivery uniform, holding a parcel.',
        confidence: MIN_DESCRIPTION_CONFIDENCE - 0.01,
      }),
    ).toBeNull();
  });

  it('emits nothing when the model breaks its own constraints', () => {
    expect(
      buildDescriptionPatch('card-1', {
        description: 'Someone who might be a delivery driver seems to be waiting outside patiently.',
        confidence: 0.99,
      }),
    ).toBeNull();
  });
});

describe('buildImagePatch', () => {
  it('carries the presigned url as the image ref', () => {
    const patch = buildImagePatch('card-1', {
      url: 'https://download-eu-south-2.prod.phoenix.devices.amazon.dev/x',
      capturedAt: 1789455093305,
      fetchedAt: 1789455097000,
    });
    expect(patch.cardId).toBe('card-1');
    expect(patch.imageRef).toContain('phoenix.devices.amazon.dev');
    expect(patch.description).toBeUndefined();
  });
});
