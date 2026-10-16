/**
 * A demo home's stand-in doorbell, through the Door agent's own path
 * (demoDoor.ts). What is real is everything after the ring: the card, the
 * roster, the timeline, the visit, the picture described by the vision step.
 * What is stood in is Ring — and Ring is never reached.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { DEMO_VISITOR_KEYS, demoVisitor, type CardPatch, type DoorRangDetail, type QueuedCard, type RosterEntry, type Visit } from '@wick/contracts';

// Ring's clients, made to fail loudly if anything here so much as touches them.
vi.mock('@wick/ring', async (original) => {
  const real = await original<typeof import('@wick/ring')>();
  const never = (name: string) => vi.fn(() => { throw new Error(`${name} must never be called for a stand-in doorbell`); });
  return {
    ...real,
    RingClient: never('RingClient'),
    ringClientsByHousehold: never('ringClientsByHousehold'),
    imageForEvent: never('imageForEvent'),
    listDevices: never('listDevices'),
    cachedDevices: never('cachedDevices'),
  };
});

import * as ring from '@wick/ring';
import { DEMO_EVENT_FRESH_MS, routeDemoDoorEvent, standInPictures, type StandInBase } from '../demoDoor.js';
import { describeViaRuntime } from '../describeRemote.js';
import { createRhythmWriter } from '../../../rhythm/writeClient.js';

const NOW = Date.UTC(2026, 9, 14, 14, 0); // a Wednesday afternoon: Maria (TUE,FRI 09:00) is not due
const PICTURES = new URL('../../../../../../docs/demo-door/', import.meta.url);

type Item = Record<string, AttributeValue>;

interface World {
  readonly base: StandInBase;
  readonly puts: Item[];
  readonly rhythm: { input: { UpdateExpression?: string; ExpressionAttributeValues?: Record<string, AttributeValue> } }[];
  readonly opened: Visit[];
  readonly cards: QueuedCard[];
  readonly patches: CardPatch[];
  readonly described: Uint8Array[];
  readonly announced: DoorRangDetail[];
}

function world(over: { roster?: readonly RosterEntry[]; family?: readonly string[]; now?: number } = {}): World {
  const puts: Item[] = [];
  const rhythm: World['rhythm'] = [];
  const opened: Visit[] = [];
  const cards: QueuedCard[] = [];
  const patches: CardPatch[] = [];
  const described: Uint8Array[] = [];
  const announced: DoorRangDetail[] = [];
  const now = over.now ?? NOW;
  const base: StandInBase = {
    put: async (item) => void puts.push(item),
    rhythm: createRhythmWriter({ send: async (command) => void rhythm.push(command as never) }, 'wick', { simulated: true }),
    visits: {
      recent: async () => [],
      open: async (visit) => (opened.push(visit), true),
      setLeft: async () => true,
    },
    listRoster: async () => over.roster ?? [],
    listFamily: async () => over.family ?? ['Guest'],
    sendToDevice: async (card) => void cards.push(card),
    sendPatch: async (patch) => void patches.push(patch),
    // The real describe dep: the frame goes to the household's AgentCore session as it would from a Ring doorbell.
    describe: (householdId) =>
      describeViaRuntime(async (kind, hh, payload) => {
        expect(kind).toBe('door.describe');
        expect(hh).toBe(householdId);
        described.push(Buffer.from(String(payload.frame), 'base64'));
        return { candidate: { description: 'A woman in a blue tunic holding a bag at the door.', confidence: 0.9, personVisible: true }, reason: 'ok', elapsedMs: 900 };
      }, householdId),
    announceRing: async (rang) => void announced.push(rang),
    pictures: standInPictures(PICTURES),
    newId: () => `id-${puts.length}`,
    now: () => now,
  };
  return { base, puts, rhythm, opened, cards, patches, described, announced };
}

const event = (over: Record<string, unknown> = {}) => ({
  householdId: 'hh-demo',
  visitor: 'stranger',
  ringId: 'ring-0123456789abcdef',
  occurredAt: NOW - 1500,
  correlationId: 'corr-demo-1',
  ...over,
});

const demoHome = async (householdId: string) => householdId === 'hh-demo';

afterEach(() => vi.clearAllMocks());

describe('routeDemoDoorEvent — somebody at a demo home’s door', () => {
  it('puts the stand-in door card on her television: labelled, with no Watch live and no chime', async () => {
    const w = world();

    expect(await routeDemoDoorEvent(event(), { isDemoHome: demoHome, base: w.base })).toBe('sent');

    expect(w.cards).toHaveLength(1);
    const { card, urgency } = w.cards[0]!;
    expect(urgency).toBe('DOOR');
    expect(card).toMatchObject({ type: 'DOOR', householdId: 'hh-demo', correlationId: 'corr-demo-1', line: "Someone's at the front door (stand-in doorbell)." });
    expect(card.actions.map((a) => a.id)).toEqual(['ask_family', 'dismiss']);
    expect(card.actions[0]!.label).toBe('Ask Guest to look');
  });

  it('says on the bus that it rang, as a real doorbell does, so an arranged visit is told', async () => {
    const w = world();

    await routeDemoDoorEvent(event(), { isDemoHome: demoHome, base: w.base });

    expect(w.announced).toEqual([{ householdId: 'hh-demo', at: NOW - 1500, cardId: w.cards[0]!.id }]);
  });

  it('rings for the visitor the member arranged: the door card says who it looks like, and who arranged it', async () => {
    const plumber: RosterEntry = { personId: 'errand:err_AAAAAAAAAAAAAAAAAAAA', name: 'the plumber', expectedOnce: { at: NOW + 5 * 60_000, windowMin: 60 }, addedBy: 'u_guest', arrangedByName: 'Guest' };
    const w = world({ roster: [plumber] });

    expect(await routeDemoDoorEvent(event({ visitor: 'arranged' }), { isDemoHome: demoHome, base: w.base })).toBe('sent');

    expect(w.cards[0]!.card).toMatchObject({ match: { personId: plumber.personId, name: 'the plumber' }, notice: 'Guest arranged this visit.' });
    expect(w.announced).toEqual([{ householdId: 'hh-demo', at: NOW - 1500, cardId: w.cards[0]!.id, matchPersonId: plumber.personId }]);
  });

  it('never constructs or calls anything of Ring’s', async () => {
    const w = world();
    await routeDemoDoorEvent(event(), { isDemoHome: demoHome, base: w.base });

    expect(ring.RingClient).not.toHaveBeenCalled();
    expect(ring.ringClientsByHousehold).not.toHaveBeenCalled();
    expect(ring.imageForEvent).not.toHaveBeenCalled();
    expect(ring.listDevices).not.toHaveBeenCalled();
    expect(ring.cachedDevices).not.toHaveBeenCalled();
  });

  it('runs Phase 2 on the stand-in picture: its published address on the card, its bytes to the vision step', async () => {
    const w = world();
    await routeDemoDoorEvent(event({ visitor: 'carer' }), { isDemoHome: demoHome, base: w.base });

    const cardId = w.cards[0]!.id;
    expect(w.patches[0]).toEqual({ cardId, imageRef: 'https://rogerjeasy.github.io/wick/demo-door/carer.jpg' });
    expect(w.described).toHaveLength(1);
    expect(Buffer.from(w.described[0]!).equals(readFileSync(new URL('carer.jpg', PICTURES)))).toBe(true);
    // The sentence is the model's, not a canned one: what the runtime answered is what is patched in.
    expect(w.patches[1]).toEqual({ cardId, description: 'A woman in a blue tunic holding a bag at the door.' });
  });

  it('marks every row it writes simulated: the door event, the rhythm counts, a presence and a visit', async () => {
    const maria: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' };
    const tuesdayMorning = Date.UTC(2026, 9, 13, 9, 5);
    const w = world({ roster: [maria], now: tuesdayMorning + 1000 });

    expect(await routeDemoDoorEvent(event({ visitor: 'carer', occurredAt: tuesdayMorning }), { isDemoHome: demoHome, base: w.base })).toBe('sent');

    expect(w.puts.map((item) => item.type?.S).sort()).toEqual(['door', 'presence']);
    for (const item of w.puts) expect(item.simulated).toEqual({ BOOL: true });
    expect(w.rhythm.length).toBeGreaterThanOrEqual(2);
    for (const command of w.rhythm) {
      expect(command.input.UpdateExpression).toContain('simulated = :simulated');
      expect(command.input.ExpressionAttributeValues?.[':simulated']).toEqual({ BOOL: true });
    }
    expect(w.opened).toEqual([expect.objectContaining({ householdId: 'hh-demo', personId: 'maria', simulated: true })]);
  });

  it('matches the carer only inside her usual time, like any doorbell', async () => {
    const maria: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' };
    const w = world({ roster: [maria] });

    await routeDemoDoorEvent(event({ visitor: 'carer' }), { isDemoHome: demoHome, base: w.base });

    expect(w.cards[0]!.card).not.toHaveProperty('match');
    expect(w.opened).toEqual([]);
    expect(w.puts.map((item) => item.type?.S)).toEqual(['door']);
  });

  it('rings as Ring would for nobody: a person-detected motion, so the headline can be corrected', async () => {
    const w = world();
    const base: StandInBase = {
      ...w.base,
      describe: (householdId) =>
        describeViaRuntime(async () => ({ candidate: { description: 'An empty doorstep with a potted plant.', confidence: 0.9, personVisible: false }, reason: 'ok', elapsedMs: 700 }), householdId),
    };

    expect(await routeDemoDoorEvent(event({ visitor: 'nobody' }), { isDemoHome: demoHome, base })).toBe('sent');

    expect(w.patches.at(-1)).toMatchObject({ line: 'Movement at the front door (stand-in doorbell).' });
  });

  it('is the same card when the same ring is delivered twice (INV-6)', async () => {
    const w = world();
    await routeDemoDoorEvent(event(), { isDemoHome: demoHome, base: w.base });
    await routeDemoDoorEvent(event(), { isDemoHome: demoHome, base: w.base });
    expect(w.cards[0]!.id).toBe(w.cards[1]!.id);
  });

  it('does nothing at all for a household that is not a demo home', async () => {
    const w = world();
    const isDemoHome = vi.fn(async () => false);

    expect(await routeDemoDoorEvent(event(), { isDemoHome, base: w.base })).toBe('not_a_demo_home');

    expect(isDemoHome).toHaveBeenCalledWith('hh-demo');
    expect(w.cards).toEqual([]);
    expect(w.puts).toEqual([]);
    expect(w.rhythm).toEqual([]);
  });

  it('refuses an event that is not well formed, or names a visitor not on the list, before asking anything', async () => {
    const w = world();
    const isDemoHome = vi.fn(demoHome);
    expect(await routeDemoDoorEvent(event({ visitor: 'burglar' }), { isDemoHome, base: w.base })).toBe('malformed');
    expect(await routeDemoDoorEvent({ ...event(), householdId: undefined }, { isDemoHome, base: w.base })).toBe('malformed');
    expect(isDemoHome).not.toHaveBeenCalled();
    expect(w.cards).toEqual([]);
  });

  it('drops a ring delivered late: someone at the door is only true for a moment', async () => {
    const w = world();
    expect(await routeDemoDoorEvent(event({ occurredAt: NOW - DEMO_EVENT_FRESH_MS - 1 }), { isDemoHome: demoHome, base: w.base })).toBe('stale');
    expect(w.cards).toEqual([]);
  });

  it('keeps no Ring device id beside the card: there is no camera to open', async () => {
    const w = world();
    const sendToDevice = vi.fn(w.base.sendToDevice);
    await routeDemoDoorEvent(event(), { isDemoHome: demoHome, base: { ...w.base, sendToDevice } });
    expect(sendToDevice).toHaveBeenCalledTimes(1);
    expect(sendToDevice.mock.calls[0]).toHaveLength(1);
  });
});

describe('standInPictures — the bytes the vision step is given', () => {
  it('has a JPEG for every stand-in visitor', async () => {
    const pictures = standInPictures(PICTURES);
    for (const key of DEMO_VISITOR_KEYS) {
      const bytes = await pictures(demoVisitor(key));
      expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]);
      expect(bytes.length).toBeGreaterThan(20_000);
    }
  });
});
