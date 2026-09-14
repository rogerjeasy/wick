import type { FactClass } from '@wick/contracts';

export type Audience = 'RESIDENT' | 'FAMILY' | 'AGENCY';

export type Transform = 'summarise' | 'redact_specifics';

export interface Decision {
  readonly allow: boolean;
  readonly transform?: Transform;
  /** Human-readable. Surfaced verbatim in the refusal — see §6.4. */
  readonly reason: string;
}

export interface EvaluatedItem {
  readonly class: FactClass;
  readonly content: string;
  readonly sourceIds: readonly string[];
}

/** A rule as it appears in the policy table. */
export interface Rule {
  readonly allow: boolean;
  readonly transform?: Transform;
  /** AGENCY only: restricts to the agency's own visits. */
  readonly ownVisitsOnly?: boolean;
}

export type PolicyTable = {
  readonly [C in FactClass]: { readonly [A in Audience]: Rule };
};

export interface HouseholdPolicy {
  readonly table: PolicyTable;
  /**
   * Set by the resident via "What Sarah Sees". Applied AFTER the table and can
   * only ever narrow. There is no path by which an exclusion widens access.
   */
  readonly residentExclusions: readonly FactClass[];
  /** Explicit, per-class opt-ins. Cannot override NEVER_TO_FAMILY. */
  readonly familyPermitted: readonly FactClass[];
}
