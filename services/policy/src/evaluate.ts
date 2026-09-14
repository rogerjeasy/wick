import { NEVER_TO_FAMILY } from '@wick/contracts';
import type { Audience, Decision, EvaluatedItem, HouseholdPolicy } from './types.js';

/**
 * The single decision function. Pure, total, and deliberately boring.
 *
 * Order matters and is the whole design:
 *   1. VERBATIM is refused to everyone but the resident, unconditionally (INV-4).
 *   2. The household table is consulted.
 *   3. An explicit family opt-in may widen — but never past NEVER_TO_FAMILY.
 *   4. Resident exclusions are applied last and can only narrow.
 *
 * Step 4 running last is what makes the resident's control real: nothing
 * downstream can re-widen what they closed.
 */
export function evaluate(
  item: EvaluatedItem,
  audience: Audience,
  policy: HouseholdPolicy,
): Decision {
  // 1 — INV-4. No verbatim utterance ever reaches a non-resident surface.
  if (item.class === 'VERBATIM' && audience !== 'RESIDENT') {
    return {
      allow: false,
      reason: 'Verbatim conversation content is never shared outside the household.',
    };
  }

  // 2 — the table.
  const rule = policy.table[item.class][audience];
  let allow = rule.allow;
  let transform = rule.transform;

  // 3 — explicit opt-in may widen, but never past the hard list.
  if (
    !allow &&
    audience === 'FAMILY' &&
    policy.familyPermitted.includes(item.class) &&
    !isNeverToFamily(item.class)
  ) {
    allow = true;
    transform = 'summarise';
  }

  // 4 — resident exclusions, last, narrowing only.
  if (allow && policy.residentExclusions.includes(item.class)) {
    return {
      allow: false,
      reason: `The resident has asked that ${humanise(item.class)} is kept private.`,
    };
  }

  if (!allow) {
    return { allow: false, reason: defaultRefusal(item.class, audience) };
  }

  return transform === undefined
    ? { allow: true, reason: 'Permitted by household policy.' }
    : { allow: true, transform, reason: 'Permitted by household policy, summarised.' };
}

function isNeverToFamily(c: EvaluatedItem['class']): boolean {
  return (NEVER_TO_FAMILY as readonly string[]).includes(c);
}

function humanise(c: EvaluatedItem['class']): string {
  return c.toLowerCase().replace(/_/g, ' ');
}

/**
 * Refusals are a product feature, not an error path. Warm, specific, never
 * silent — silence is indistinguishable from "nothing happened", which is a lie.
 * See docs/WICK-TECHNICAL.md §6.4.
 */
function defaultRefusal(c: EvaluatedItem['class'], audience: Audience): string {
  if (audience === 'AGENCY') return 'Not shared with care agencies.';
  return `That's something the resident is keeping to themselves. I'm not able to share it.`;
}
