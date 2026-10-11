import { describe, it, expect } from 'vitest';
import { MAX_CARD_ACTIONS, type RosterEntry } from '@wick/contracts';
import type { RingDevice, RingHistoryEvent } from '@wick/ring';
import {
  DOOR_LINE,
  buildPhaseOneCard,
  buildImagePatch,
  buildDescriptionPatch,
  parseDescribeReply,
  NOBODY_AFTER_MOTION_LINE,
  NOBODY_AFTER_RING_LINE,
  validateDescription,
  DESCRIPTION_MAX_WORDS,
  MIN_DESCRIPTION_CONFIDENCE,
} from '../index.js';

const device: RingDevice = {
  id: 'ava1.ring.device.ABNJQ',
  name: 'Front Door',
  online: true,
  capabilities: { motion: true, image: true, chime: false },
};

const event: RingHistoryEvent = {
  id: 'ava1.ring.history.event.XWRR',
  deviceId: 'ava1.ring.device.ABNJQ',
  start: 1789455093305,
  end: 1789455104824,
  eventType: 'ding',
  detections: [],
};

const build = (hallwayChime: boolean) =>
  buildPhaseOneCard({
    event,
    device,
    hallwayChime,
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

  it('offers all three buttons when the household has a playable hallway chime', () => {
    const actions = build(true).actions;
    expect(actions.map((a) => a.id)).toEqual(['watch_live', 'hallway_chime', 'dismiss']);
    expect(actions[1]!.label).toBe('Ring the hallway chime');
  });

  it('drops the chime button when there is no chime to ring, rather than offering one that fails', () => {
    expect(build(false).actions.map((a) => a.id)).toEqual(['watch_live', 'dismiss']);
  });

  it('always keeps a way out, and never exceeds three actions', () => {
    for (const hallwayChime of [true, false]) {
      const actions = build(hallwayChime).actions;
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
      device,
      hallwayChime: true,
      householdId: 'hh-1',
      correlationId: 'corr-abc',
      now: 1789455094000,
    });
    expect(other.id).not.toBe(build(true).id);
  });

  it('has no match at all when no roster is given — the common, unremarkable case', () => {
    expect(build(true).match).toBeUndefined();
  });
});

describe('buildPhaseOneCard — M4 Known Visitors', () => {
  const maria: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' };
  // Tuesday 2026-09-15 09:10 UTC — inside Maria's expected window.
  const tuesdayEvent: RingHistoryEvent = { ...event, start: Date.UTC(2026, 8, 15, 9, 10) };

  it('carries a schedule match onto the card when the roster and time line up', () => {
    const card = buildPhaseOneCard({
      event: tuesdayEvent,
      device,
      hallwayChime: true,
      householdId: 'hh-1',
      correlationId: 'corr-abc',
      now: 1789455094000,
      roster: [maria],
    });
    expect(card.match).toMatchObject({ personId: 'maria', name: 'Maria', basis: 'schedule' });
  });

  it('carries no match when nobody on the roster fits the event time', () => {
    const monday: RingHistoryEvent = { ...event, start: Date.UTC(2026, 8, 14, 9, 10) };
    const card = buildPhaseOneCard({
      event: monday,
      device,
      hallwayChime: true,
      householdId: 'hh-1',
      correlationId: 'corr-abc',
      now: 1789455094000,
      roster: [maria],
    });
    expect(card.match).toBeUndefined();
  });
});

describe('buildPhaseOneCard — asking the family to look', () => {
  const maria: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' };
  const withFamily = (family: readonly string[], over: { hallwayChime?: boolean; start?: number; roster?: readonly RosterEntry[] } = {}) =>
    buildPhaseOneCard({
      event: { ...event, start: over.start ?? event.start },
      device,
      hallwayChime: over.hallwayChime ?? false,
      householdId: 'hh-1',
      correlationId: 'corr-abc',
      now: 1789455094000,
      family,
      ...(over.roster ? { roster: over.roster } : {}),
    });

  it('offers to ask the one person the resident has allowed, by first name, when nobody is expected', () => {
    const actions = withFamily(['Sarah Whitfield']).actions;
    expect(actions.map((a) => a.id)).toEqual(['watch_live', 'ask_family', 'dismiss']);
    expect(actions[1]).toEqual({ id: 'ask_family', label: 'Ask Sarah to look', kind: 'secondary' });
  });

  it('asks "the family" when more than one person could answer', () => {
    expect(withFamily(['Sarah', 'Tom']).actions[1]!.label).toBe('Ask the family to look');
  });

  it('asks "the family" rather than squeeze a long name onto a button', () => {
    expect(withFamily(['Bartholomew-James Whitfield']).actions[1]!.label).toBe('Ask the family to look');
  });

  it('offers nothing when the resident has allowed nobody — a button that reaches no one is worse than none', () => {
    expect(withFamily([]).actions.map((a) => a.id)).toEqual(['watch_live', 'dismiss']);
    expect(build(false).actions.map((a) => a.id)).toEqual(['watch_live', 'dismiss']);
  });

  it('offers nothing when the visitor is someone the household expects', () => {
    // Tuesday 2026-09-15 09:10 UTC — inside Maria's expected window.
    const card = withFamily(['Sarah'], { start: Date.UTC(2026, 8, 15, 9, 10), roster: [maria] });
    expect(card.match?.name).toBe('Maria');
    expect(card.actions.map((a) => a.id)).toEqual(['watch_live', 'dismiss']);
  });

  it('takes the middle place from the hallway chime — three buttons, never four', () => {
    const actions = withFamily(['Sarah'], { hallwayChime: true }).actions;
    expect(actions.map((a) => a.id)).toEqual(['watch_live', 'ask_family', 'dismiss']);
    expect(actions.length).toBeLessThanOrEqual(MAX_CARD_ACTIONS);
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

describe('parseDescribeReply — the model says whether anyone is in the frame', () => {
  it('reads PERSON: no and the sentence after it', () => {
    expect(parseDescribeReply('PERSON: no\nThree cars parked in a parking lot.')).toEqual({
      personVisible: false,
      sentence: 'Three cars parked in a parking lot.',
    });
  });

  it('reads PERSON: yes', () => {
    expect(parseDescribeReply('PERSON: yes\nA man in a delivery uniform, holding a parcel.')).toEqual({
      personVisible: true,
      sentence: 'A man in a delivery uniform, holding a parcel.',
    });
  });

  it('tolerates case and spacing', () => {
    expect(parseDescribeReply('  person:NO  \n\n  An empty porch with a potted plant. ')).toEqual({
      personVisible: false,
      sentence: 'An empty porch with a potted plant.',
    });
  });

  it('leaves personVisible unknown when the model ignores the format — never guessed', () => {
    expect(parseDescribeReply('A man holding a parcel.')).toEqual({
      personVisible: undefined,
      sentence: 'A man holding a parcel.',
    });
  });

  it('passes UNCLEAR through as the sentence, for describe.ts to decline on', () => {
    expect(parseDescribeReply('PERSON: no\nUNCLEAR').sentence).toBe('UNCLEAR');
  });
});

describe('buildDescriptionPatch — the headline never contradicts the picture', () => {
  // Observed on the VVD: "Three cars parked in a parking lot." rendered
  // directly under "Someone's at the front door."
  const nobody = { description: 'Three cars parked in a parking lot.', confidence: 0.9, personVisible: false };

  it('corrects the headline after motion when nobody is in the frame', () => {
    expect(buildDescriptionPatch('card-1', nobody, 'motion_detected')).toEqual({
      cardId: 'card-1',
      description: 'Three cars parked in a parking lot.',
      line: NOBODY_AFTER_MOTION_LINE,
    });
  });

  it('after a button press, says the doorbell rang — that part is certain, whoever is in view', () => {
    expect(buildDescriptionPatch('card-1', nobody, 'button_press')?.line).toBe(NOBODY_AFTER_RING_LINE);
  });

  it('leaves the headline alone when someone is in the frame', () => {
    const patch = buildDescriptionPatch('card-1', { ...nobody, personVisible: true }, 'motion_detected');
    expect(patch).not.toHaveProperty('line');
  });

  it('leaves the headline alone when presence is unknown — a correction is a claim too', () => {
    const { personVisible: _unknown, ...candidate } = nobody;
    expect(buildDescriptionPatch('card-1', candidate, 'motion_detected')).not.toHaveProperty('line');
  });

  it('the corrected lines are themselves plain, observable statements', () => {
    expect(validateDescription(NOBODY_AFTER_MOTION_LINE)).toBe(true);
    expect(validateDescription(NOBODY_AFTER_RING_LINE)).toBe(true);
    expect(NOBODY_AFTER_MOTION_LINE).not.toBe(DOOR_LINE);
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
