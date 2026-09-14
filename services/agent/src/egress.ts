/**
 * THE SINGLE EGRESS MODULE.  INV-2.
 *
 * This is the only module in the repository permitted to import a transport
 * client. Every other module calls sendToFamily() / sendToDevice(). An ESLint
 * no-restricted-imports rule enforces it — a rule you can run beats a convention
 * you can only remember.
 *
 * Why it matters beyond tidiness: prompt injection is a live threat here. Bee
 * captures whatever was said, and a visitor's clothing or signage lands inside a
 * vision prompt. Because the Guardian runs HERE — deterministically, after
 * generation, on typed classes — a model that gets talked into emitting a health
 * fact still cannot get it past the gate.
 *
 * See docs/WICK-TECHNICAL.md §6.3, §10.2.
 */
import { evaluate, type Audience, type HouseholdPolicy } from '@wick/policy';
import type { FactClass, QueuedCard } from '@wick/contracts';

export interface EgressItem {
  readonly class: FactClass;
  readonly content: string;
  readonly sourceIds: readonly string[];
  readonly correlationId: string;
}

export type EgressResult =
  | { readonly sent: true; readonly content: string }
  | { readonly sent: false; readonly reason: string };

/**
 * The only path to a family surface.
 *
 * A Guardian that throws must fail CLOSED — refuse, alarm, and never fall
 * through to sending. See §11.
 */
export async function sendToFamily(
  item: EgressItem,
  audience: Extract<Audience, 'FAMILY' | 'AGENCY'>,
  policy: HouseholdPolicy,
): Promise<EgressResult> {
  let decision;
  try {
    decision = evaluate(item, audience, policy);
  } catch {
    // Fail closed. Emit guardian.error; the alarm is wired in infra/.
    return { sent: false, reason: 'Unable to share that right now.' };
  }

  if (!decision.allow) return { sent: false, reason: decision.reason };

  // TODO(S5): apply decision.transform ('summarise' | 'redact_specifics') before send.
  // TODO(S5): log { class, audience, allow, transform, reason } — NEVER content (§11).
  throw new Error('not implemented');
}

/**
 * The only path to the television.
 *
 * The resident is always audience RESIDENT, so the Guardian is permissive here —
 * but it still runs, because "the resident sees everything about themselves" is a
 * policy decision, not an absence of policy.
 */
export async function sendToDevice(
  _card: QueuedCard,
  _policy: HouseholdPolicy,
): Promise<void> {
  throw new Error('not implemented');
}
