/**
 * Facts — the only thing that ever leaves the household from Bee.
 *
 * INV-4: raw utterances are dropped at the household boundary by the Bee bridge
 * (services/connectors/bee). Nothing in this type can carry a verbatim quote, and
 * nothing downstream should ever add one.
 *
 * See docs/WICK-TECHNICAL.md §6, §7.2.
 */

/** Disclosure classes. The Guardian's policy table is keyed on these. */
export type FactClass =
  | 'DOOR_EVENT'
  | 'PRESENCE'
  | 'COMMITMENT'
  | 'RHYTHM'
  | 'HEALTH'
  | 'FINANCIAL'
  | 'RELATIONSHIP'
  | 'LOCATION'
  | 'VERBATIM';

/**
 * Classes that may never reach a family surface in original form, under any
 * policy. Exported so the Guardian and its tests share one definition.
 */
export const NEVER_TO_FAMILY: readonly FactClass[] = [
  'HEALTH',
  'FINANCIAL',
  'RELATIONSHIP',
  'LOCATION',
  'VERBATIM',
] as const;

export interface Fact {
  readonly id: string;
  readonly householdId: string;
  readonly class: FactClass;
  /** Derived, paraphrased content. NEVER a verbatim utterance. INV-4. */
  readonly content: string;
  /** Upstream identifiers for audit. Never rendered to any surface. */
  readonly sourceIds: readonly string[];
  readonly observedAt: number;
  /** 0..1. Below the agent's threshold, the fact is not surfaced at all. */
  readonly confidence: number;
}

export interface Commitment extends Fact {
  readonly class: 'COMMITMENT';
  readonly dueAt?: number;
  readonly subject?: string;
}
