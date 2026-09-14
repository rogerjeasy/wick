import { describe, expect, it } from 'vitest';
import { NEVER_TO_FAMILY, type FactClass } from '@wick/contracts';
import { DEFAULT_POLICY, evaluate } from '../index.js';
import type { Audience } from '../types.js';

const ALL_CLASSES: FactClass[] = [
  'DOOR_EVENT', 'PRESENCE', 'COMMITMENT', 'RHYTHM',
  'HEALTH', 'FINANCIAL', 'RELATIONSHIP', 'LOCATION', 'VERBATIM',
];
const ALL_AUDIENCES: Audience[] = ['RESIDENT', 'FAMILY', 'AGENCY'];

const item = (c: FactClass) => ({ class: c, content: 'x', sourceIds: ['s1'] });

describe('the policy matrix', () => {
  it('is total — every class × audience yields a decision with a reason', () => {
    for (const c of ALL_CLASSES) {
      for (const a of ALL_AUDIENCES) {
        const d = evaluate(item(c), a, DEFAULT_POLICY);
        expect(typeof d.allow).toBe('boolean');
        expect(d.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('allows the resident to see everything about themselves', () => {
    for (const c of ALL_CLASSES) {
      expect(evaluate(item(c), 'RESIDENT', DEFAULT_POLICY).allow).toBe(true);
    }
  });

  it('never allows a NEVER_TO_FAMILY class to reach the family', () => {
    for (const c of NEVER_TO_FAMILY) {
      expect(evaluate(item(c), 'FAMILY', DEFAULT_POLICY).allow).toBe(false);
    }
  });

  it('summarises rhythm and commitments for family rather than sharing raw', () => {
    for (const c of ['RHYTHM', 'COMMITMENT'] as const) {
      const d = evaluate(item(c), 'FAMILY', DEFAULT_POLICY);
      expect(d.allow).toBe(true);
      expect(d.transform).toBe('summarise');
    }
  });

  it('gives an agency only door and presence, and only its own visits', () => {
    for (const c of ALL_CLASSES) {
      const d = evaluate(item(c), 'AGENCY', DEFAULT_POLICY);
      const expected = c === 'DOOR_EVENT' || c === 'PRESENCE';
      expect(d.allow).toBe(expected);
    }
  });
});

describe('resident exclusions', () => {
  it('narrow an otherwise permitted class', () => {
    const policy = { ...DEFAULT_POLICY, residentExclusions: ['DOOR_EVENT' as FactClass] };
    expect(evaluate(item('DOOR_EVENT'), 'FAMILY', DEFAULT_POLICY).allow).toBe(true);
    expect(evaluate(item('DOOR_EVENT'), 'FAMILY', policy).allow).toBe(false);
  });

  it('are applied last, so nothing downstream can re-widen them', () => {
    const policy = {
      ...DEFAULT_POLICY,
      familyPermitted: ['COMMITMENT' as FactClass],
      residentExclusions: ['COMMITMENT' as FactClass],
    };
    expect(evaluate(item('COMMITMENT'), 'FAMILY', policy).allow).toBe(false);
  });
});

describe('family opt-in', () => {
  it('cannot widen past the hard list', () => {
    const policy = { ...DEFAULT_POLICY, familyPermitted: [...NEVER_TO_FAMILY] };
    for (const c of NEVER_TO_FAMILY) {
      expect(evaluate(item(c), 'FAMILY', policy).allow).toBe(false);
    }
  });
});
