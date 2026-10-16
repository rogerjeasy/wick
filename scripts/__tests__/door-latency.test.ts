import { describe, expect, it } from 'vitest';
import { RingTimer, circleCardId, doorSignals, edgeUrlsIn, seconds, summarise, waitBeforeNextRing } from '../door-latency/measure.js';

const doorCard = (id: string) => ({ kind: 'card', card: { card: { type: 'DOOR', id, line: 'Someone is at the front door.' } } });
const patch = (cardId: string, fields: Record<string, unknown>) => ({ kind: 'control', control: { t: 'patch', patch: { cardId, ...fields } } });

describe('door latency: reading the wire', () => {
  it('knows a door card, a picture patch and a sentence patch', () => {
    expect(doorSignals(doorCard('door-1'))).toEqual([{ step: 'card', cardId: 'door-1' }]);
    expect(doorSignals(patch('door-1', { imageRef: 'https://x/p.jpg' }))).toEqual([{ step: 'picture', cardId: 'door-1' }]);
    expect(doorSignals(patch('door-1', { description: 'A person in a blue coat.' }))).toEqual([{ step: 'description', cardId: 'door-1' }]);
    expect(doorSignals(patch('door-1', { imageRef: 'i', description: 'd' }))).toEqual([
      { step: 'picture', cardId: 'door-1' },
      { step: 'description', cardId: 'door-1' },
    ]);
  });

  it('ignores everything else', () => {
    for (const msg of [null, 'x', {}, { kind: 'card', card: { card: { type: 'WEEK', id: 'w' } } }, patch('door-1', { line: 'Nobody' }), { kind: 'control', control: { t: 'revoke', cardId: 'door-1' } }]) {
      expect(doorSignals(msg)).toEqual([]);
    }
  });

  it('finds the Circle card about one member only', () => {
    const circle = { kind: 'card', card: { card: { type: 'CIRCLE', id: 'circle-u1' } } };
    expect(circleCardId(circle, 'u1')).toBe('circle-u1');
    expect(circleCardId(circle, 'u2')).toBeUndefined();
    expect(circleCardId(doorCard('circle-u1'), 'u1')).toBeUndefined();
  });

  it('reads the deployed edge addresses from device.js, and not its placeholders', () => {
    const js = "const PAIRING_API_URL = 'https://p.example';\nconst WEBSOCKET_URL = 'wss://w.example/prod';\n";
    expect(edgeUrlsIn(js)).toEqual({ pairing: 'https://p.example', websocket: 'wss://w.example/prod' });
    expect(edgeUrlsIn("const PAIRING_API_URL = 'PAIRING_API_URL_PLACEHOLDER';")).toEqual({ pairing: undefined, websocket: undefined });
  });
});

describe('door latency: one ring', () => {
  it('times the first new door card, then that card’s picture and sentence', () => {
    const ring = new RingTimer(1_000, ['old-door']);
    ring.note({ step: 'card', cardId: 'old-door' }, 1_100);
    ring.note({ step: 'picture', cardId: 'old-door' }, 1_200);
    expect(ring.cardId).toBeUndefined();
    ring.note({ step: 'card', cardId: 'door-2' }, 2_500);
    ring.note({ step: 'picture', cardId: 'other' }, 2_600);
    ring.note({ step: 'picture', cardId: 'door-2' }, 4_000);
    ring.note({ step: 'card', cardId: 'door-3' }, 4_100);
    expect(ring.complete).toBe(false);
    ring.note({ step: 'description', cardId: 'door-2' }, 6_000);
    ring.note({ step: 'description', cardId: 'door-2' }, 9_000);
    expect(ring.at).toEqual({ card: 1_500, picture: 3_000, description: 5_000 });
    expect(ring.cardId).toBe('door-2');
    expect(ring.complete).toBe(true);
  });
});

describe('door latency: summing up', () => {
  it('gives the median and the max of what was seen', () => {
    expect(summarise([3, 1, 2])).toEqual({ n: 3, median: 2, max: 3 });
    expect(summarise([4, 1, 2, 3])).toEqual({ n: 4, median: 2.5, max: 4 });
    expect(summarise([])).toEqual({ n: 0, median: undefined, max: undefined });
  });

  it('waits out the stand-in doorbell’s cooldown between rings', () => {
    expect(waitBeforeNextRing(undefined, 5_000, 20_000)).toBe(0);
    expect(waitBeforeNextRing(0, 5_000, 20_000)).toBe(16_000);
    expect(waitBeforeNextRing(0, 30_000, 20_000)).toBe(0);
  });

  it('says seconds to two places, or that a step was not seen', () => {
    expect(seconds(1_234)).toBe('1.23 s');
    expect(seconds(undefined)).toBe('not seen');
  });
});
