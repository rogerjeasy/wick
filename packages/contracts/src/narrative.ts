/**
 * The weekly narrative.
 *
 * INV-7: written to the resident's television first; `residentSeenAt` gates
 * family readability. Nothing is said about the resident behind their back.
 *
 * Precomputed on a schedule — never generated inside an MCP tool call, because
 * Alexa+ requires sub-500ms round trips. See docs/WICK-TECHNICAL.md §5.4, §9.3.
 */

import { MAX_CARD_DETAIL_CHARS } from './card.js';

/**
 * The longest narrative Wick will write. It is shown on the resident's
 * television above the one button that releases it to the family (INV-7),
 * so it must fit a card's body and leave that button on screen. It is also
 * what Alexa reads aloud, where short is kinder anyway. The Narrator
 * enforces it (weekFacts.ts).
 */
export const MAX_NARRATIVE_CHARS = MAX_CARD_DETAIL_CHARS;

export interface RhythmDelta {
  /** `door`, or `visit:<personId>`. */
  readonly metric: string;
  /** What a person would call it: "the front door", "Maria". */
  readonly label?: string;
  readonly thisWeek: number;
  /** The same stretch of last week. Absent when last week was not observed. */
  readonly lastWeek?: number;
  /** The mean of the observed weeks before this one — at most six. */
  readonly baseline: number;
  /** 0 below three weeks of baseline. */
  readonly zScore: number;
  /** Deviations are suppressed below three weeks of baseline. See §8.2. */
  readonly baselineWeeks: number;
  /** Absent below three weeks of baseline: there is no usual week yet. */
  readonly verdict?: 'usual' | 'more' | 'fewer';
}

export interface WeekNarrative {
  readonly householdId: string;
  readonly isoWeek: string;
  /** Prose, written by the model from numbers computed deterministically. */
  readonly text: string;
  /**
   * 'model' when the model's prose passed the Narrator's number and length
   * check; 'facts' when it failed twice, or the model was unreachable, and
   * the week was written from the counted facts alone. Absent on weeks
   * written before 2026-10-01.
   */
  readonly textSource?: 'model' | 'facts';
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
