/**
 * The property suite referenced in docs/WICK-TECHNICAL.md §6.3.
 *
 * This is a demo artefact: it going green on camera is part of the case that
 * Wick's privacy claim is enforced rather than asserted. Keep the case count
 * high enough that the claim is meaningful.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { NEVER_TO_FAMILY, type FactClass } from '@wick/contracts';
import { DEFAULT_TABLE, evaluate } from '../index.js';
import type { HouseholdPolicy } from '../types.js';

const RUNS = 10_000;

const ALL_CLASSES: FactClass[] = [
  'DOOR_EVENT', 'PRESENCE', 'COMMITMENT', 'RHYTHM',
  'HEALTH', 'FINANCIAL', 'RELATIONSHIP', 'LOCATION', 'VERBATIM',
];

const arbClass = fc.constantFrom(...ALL_CLASSES);
const arbProtected = fc.constantFrom(...NEVER_TO_FAMILY);

/** Any policy an attacker or a bug could construct, including absurd ones. */
const arbPolicy: fc.Arbitrary<HouseholdPolicy> = fc.record({
  table: fc.constant(DEFAULT_TABLE),
  residentExclusions: fc.uniqueArray(arbClass),
  familyPermitted: fc.uniqueArray(arbClass),
});

const arbItem = (c: fc.Arbitrary<FactClass>) =>
  fc.record({
    class: c,
    content: fc.string({ minLength: 1, maxLength: 200 }),
    sourceIds: fc.array(fc.string({ minLength: 1 }), { maxLength: 4 }),
  });

describe('Guardian invariants', () => {
  it('INV-4: no protected class ever reaches FAMILY, under any policy', () => {
    fc.assert(
      fc.property(arbItem(arbProtected), arbPolicy, (item, policy) => {
        expect(evaluate(item, 'FAMILY', policy).allow).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('a resident exclusion is always honoured, whatever else the policy says', () => {
    fc.assert(
      fc.property(arbItem(arbClass), arbPolicy, (item, policy) => {
        if (!policy.residentExclusions.includes(item.class)) return;
        expect(evaluate(item, 'FAMILY', policy).allow).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('is total: never throws, always explains itself', () => {
    fc.assert(
      fc.property(
        arbItem(arbClass),
        fc.constantFrom('RESIDENT' as const, 'FAMILY' as const, 'AGENCY' as const),
        arbPolicy,
        (item, audience, policy) => {
          const d = evaluate(item, audience, policy);
          expect(d.reason.trim().length).toBeGreaterThan(0);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('an allowed protected-adjacent class is always transformed, never raw', () => {
    fc.assert(
      fc.property(
        arbItem(fc.constantFrom('RHYTHM' as FactClass, 'COMMITMENT' as FactClass)),
        arbPolicy,
        (item, policy) => {
          const d = evaluate(item, 'FAMILY', policy);
          if (d.allow) expect(d.transform).toBeDefined();
        },
      ),
      { numRuns: RUNS },
    );
  });
});
