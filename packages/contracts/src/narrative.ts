/**
 * The weekly narrative.
 *
 * INV-7: written to the resident's television first; `residentSeenAt` gates
 * family readability. Nothing is said about the resident behind their back.
 *
 * Precomputed on a schedule — never generated inside an MCP tool call, because
 * Alexa+ requires sub-500ms round trips. See docs/WICK-TECHNICAL.md §5.4, §9.3.
 */

export interface RhythmDelta {
  readonly metric: string;
  readonly thisWeek: number;
  readonly baseline: number;
  readonly zScore: number;
  /** Deviations are suppressed below three weeks of baseline. See §8.2. */
  readonly baselineWeeks: number;
}

export interface WeekNarrative {
  readonly householdId: string;
  readonly isoWeek: string;
  /** Prose, written by the model from numbers computed deterministically. */
  readonly text: string;
  readonly deltas: readonly RhythmDelta[];
  readonly timeline: readonly TimelineEntry[];
  readonly generatedAt: number;
  /** INV-7 gate. Until set, no family surface may read this. */
  readonly residentSeenAt?: number;
}

export interface TimelineEntry {
  readonly at: number;
  readonly kind: 'door' | 'presence' | 'visit' | 'card' | 'deviation';
  readonly summary: string;
  readonly personId?: string;
}
