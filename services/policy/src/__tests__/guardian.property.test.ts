/**
 * The content gate's property suite (docs/WICK-TECHNICAL.md §6.3).
 *
 * Every phrase the lexicon lists, in any case, with accents added, in
 * full-width letters, anywhere in any string, under any household policy:
 * never cleared for the family. The runtime path that carries this to a
 * family member is tested the same way in services/mcp-server
 * (src/__tests__/guardian.property.test.ts).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { type FactClass } from '@wick/contracts';
import { DEFAULT_TABLE, LEXICON, clearForFamily } from '../index.js';
import type { HouseholdPolicy } from '../types.js';

const RUNS = 10_000;

const ALL_CLASSES: FactClass[] = [
  'DOOR_EVENT', 'PRESENCE', 'COMMITMENT', 'RHYTHM',
  'HEALTH', 'FINANCIAL', 'RELATIONSHIP', 'LOCATION', 'VERBATIM',
];
const arbClass = fc.constantFrom(...ALL_CLASSES);

/** Any policy a bug could construct, including absurd ones. */
const arbPolicy: fc.Arbitrary<HouseholdPolicy> = fc.record({
  table: fc.constant(DEFAULT_TABLE),
  residentExclusions: fc.uniqueArray(arbClass),
  familyPermitted: fc.uniqueArray(arbClass),
});

/** Every phrase the lexicon says it catches. */
const MARKERS: readonly string[] = LEXICON.flatMap((m) => m.examples);

/** A letter as it might be typed: either case, with an accent, or full-width. */
const disguise = (c: string, how: number): string => {
  if (!/[a-z]/i.test(c)) return c;
  switch (how % 4) {
    case 0: return c.toUpperCase();
    case 1: return c.toLowerCase();
    case 2: return `${c}\u0301`;
    default: return String.fromCharCode(c.toUpperCase().charCodeAt(0) - 0x41 + 0xff21);
  }
};

const arbMarker = fc
  .tuple(fc.constantFrom(...MARKERS), fc.array(fc.nat(3), { minLength: 1, maxLength: 40 }))
  .map(([marker, hows]) => [...marker].map((c, i) => disguise(c, hows[i % hows.length]!)).join(''));

/** What can stand either side of a word. */
const arbEdge = fc.constantFrom(' ', '. ', ', ', '\n', ' (', ') ', ' “', '” ', ' - ', '? ', '! ');

/** A string with a protected phrase somewhere in it, as a word of its own. */
const arbProtectedText = fc
  .tuple(fc.string({ maxLength: 60 }), arbEdge, arbMarker, arbEdge, fc.string({ maxLength: 60 }))
  .map(([before, l, marker, r, after]) => `${before}${l}${marker}${r}${after}`);

describe('the content gate', () => {
  it('never clears a string with a protected phrase in it, however it is written, under any policy', () => {
    fc.assert(
      fc.property(arbProtectedText, arbPolicy, (text, policy) => {
        expect(clearForFamily(text, policy).cleared).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('gives the same answer whatever the household policy says', () => {
    fc.assert(
      fc.property(fc.oneof(arbProtectedText, fc.string({ maxLength: 120 })), arbPolicy, (text, policy) => {
        expect(clearForFamily(text, policy).cleared).toBe(clearForFamily(text).cleared);
      }),
      { numRuns: RUNS },
    );
  });

  it('is total: never throws, and a cleared string is the string itself', () => {
    fc.assert(
      fc.property(fc.fullUnicodeString({ maxLength: 200 }), (text) => {
        const clearance = clearForFamily(text);
        if (clearance.cleared) expect(clearance.text).toBe(text);
      }),
      { numRuns: RUNS },
    );
  });
});
