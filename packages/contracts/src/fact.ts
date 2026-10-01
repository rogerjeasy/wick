/**
 * Disclosure classes — what a piece of information is about, which is what
 * decides who may be told it.
 *
 * INV-4: nothing protected, and nothing verbatim, reaches the family. The
 * Guardian (services/policy) refuses those classes for a FAMILY audience
 * under every policy, after generation, whatever a model was talked into
 * writing.
 *
 * See docs/WICK-TECHNICAL.md §6.
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
