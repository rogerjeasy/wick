/**
 * The Sunday brief's one suggestion: what the family member could do about
 * the week, chosen by an agent from a fixed menu and checked by code
 * (services/agent/src/graphs/weeklyBrief.ts). The reason is one short
 * sentence grounded in the week's counted facts; it passes the Guardian
 * before anyone reads it.
 */

export const SUGGESTED_ACTIONS = ['send_note', 'arrange_visit', 'watch_together', 'nothing'] as const;
export type SuggestedAction = (typeof SUGGESTED_ACTIONS)[number];

export const BRIEF_REASON_MAX_CHARS = 140;

export interface BriefSuggestion {
  readonly action: SuggestedAction;
  readonly reason: string;
}

export const isSuggestedAction = (value: unknown): value is SuggestedAction =>
  typeof value === 'string' && (SUGGESTED_ACTIONS as readonly string[]).includes(value);

/** A suggestion, or undefined if it is not one: from a model, so read, not trusted. */
export function readBriefSuggestion(raw: unknown): BriefSuggestion | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isSuggestedAction(r.action) || typeof r.reason !== 'string') return undefined;
  const reason = r.reason.trim();
  if (!reason || reason.length > BRIEF_REASON_MAX_CHARS) return undefined;
  return { action: r.action, reason };
}
