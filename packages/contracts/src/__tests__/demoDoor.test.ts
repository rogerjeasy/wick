import { describe, expect, it } from 'vitest';
import {
  DEMO_DOOR_DETAIL_TYPE,
  DEMO_DOOR_PICTURES_URL,
  DEMO_DOOR_SOURCE,
  DEMO_VISITOR_KEYS,
  demoDoorEventOf,
  demoVisitor,
  isDemoVisitorKey,
} from '../demoDoor.js';

describe('the stand-in doorbell (demoDoor.ts)', () => {
  it('has a fixed list of stand-in visitors, and nothing else is one', () => {
    expect(DEMO_VISITOR_KEYS).toEqual(['carer', 'parcel', 'stranger', 'nobody', 'arranged']);
    for (const key of DEMO_VISITOR_KEYS) expect(isDemoVisitorKey(key)).toBe(true);
    for (const other of ['', 'Carer', 'maria', 'toString', '__proto__', 7, null, undefined, { key: 'carer' }]) {
      expect(isDemoVisitorKey(other)).toBe(false);
    }
  });

  it('rings like a Ring doorbell would: a press for somebody, a person-detected motion for nobody', () => {
    expect(demoVisitor('carer')).toMatchObject({ eventType: 'button_press' });
    expect(demoVisitor('parcel')).toMatchObject({ eventType: 'button_press' });
    expect(demoVisitor('stranger')).toMatchObject({ eventType: 'button_press' });
    expect(demoVisitor('arranged')).toMatchObject({ eventType: 'button_press' });
    // Ring said a person moved; the picture shows nobody. The door agent's headline is then corrected.
    expect(demoVisitor('nobody')).toMatchObject({ eventType: 'motion_detected', subType: 'human' });
  });

  it('serves each picture over https, from the published docs', () => {
    expect(DEMO_DOOR_PICTURES_URL).toBe('https://rogerjeasy.github.io/wick/demo-door/');
    for (const key of DEMO_VISITOR_KEYS) {
      const visitor = demoVisitor(key);
      expect(visitor.picture).toBe(`${key}.jpg`);
      expect(visitor.pictureUrl).toBe(`https://rogerjeasy.github.io/wick/demo-door/${key}.jpg`);
    }
  });

  it('rings now for the visitor a member arranged (errand.ts), with a picture of its own: a tradesman, not the delivery', () => {
    expect(demoVisitor('arranged')).toMatchObject({
      label: 'The visitor you arranged',
      picture: 'arranged.jpg',
      pictureUrl: 'https://rogerjeasy.github.io/wick/demo-door/arranged.jpg',
    });
  });

  it('labels every visitor as a stand-in in the family app', () => {
    for (const key of DEMO_VISITOR_KEYS) expect(demoVisitor(key).label.length).toBeGreaterThan(0);
  });

  describe('demoDoorEventOf — the event the Wick server hands the door agent', () => {
    const good = { householdId: 'hh-demo', visitor: 'parcel', ringId: 'ring-0123456789abcdef', occurredAt: 1_790_000_000_000, correlationId: 'corr-1' };

    it('reads a well-formed one', () => {
      expect(demoDoorEventOf(good)).toEqual(good);
    });

    it('refuses one that is missing anything, or names a visitor not on the list', () => {
      for (const field of Object.keys(good) as (keyof typeof good)[]) {
        const { [field]: _gone, ...rest } = good;
        expect(demoDoorEventOf(rest)).toBeUndefined();
      }
      expect(demoDoorEventOf({ ...good, visitor: 'burglar' })).toBeUndefined();
      expect(demoDoorEventOf({ ...good, occurredAt: 'yesterday' })).toBeUndefined();
      expect(demoDoorEventOf({ ...good, householdId: '' })).toBeUndefined();
      expect(demoDoorEventOf({ ...good, ringId: 'short' })).toBeUndefined();
      expect(demoDoorEventOf({ ...good, ringId: 'has spaces in it, so not one' })).toBeUndefined();
      expect(demoDoorEventOf(null)).toBeUndefined();
    });

    it('is told apart from a Ring event by its source, which nothing but the Wick server sends', () => {
      expect(DEMO_DOOR_SOURCE).toBe('wick.demo-door');
      expect(DEMO_DOOR_SOURCE).not.toBe('wick.ring');
      expect(DEMO_DOOR_DETAIL_TYPE).toBe('demo.doorbell');
    });
  });
});
