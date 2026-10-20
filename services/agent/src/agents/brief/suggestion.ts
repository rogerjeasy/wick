/**
 * The Sunday brief's one suggestion: what the family member could do about
 * the week, from a fixed menu (packages/contracts brief.ts).
 *
 * A model chooses the words and picks from the menu; code decides whether
 * the pick makes sense (AGENTS.md: a model chooses words, code decides what
 * happens). "Arrange a visit" only when a usual visit was missed; "Watch a
 * film together" only when she watched films that week; otherwise a note,
 * or nothing. The reason is one short sentence, held to the week's numbers
 * like the paragraph is (checkNarrative), and it passes the Guardian before
 * anyone reads it (INV-2). The validate node adds the Guardrail's grounding
 * check (graphs/weeklyBrief.ts). Anything that fails becomes NO_SUGGESTION.
 */
import { z } from 'zod';
import { BRIEF_REASON_MAX_CHARS, SUGGESTED_ACTIONS, readBriefSuggestion, type BriefSuggestion, type SuggestedAction } from '@wick/contracts';
import { clearForFamily, type HouseholdPolicy } from '@wick/policy';

export interface SuggestionContext {
  /** A regular visitor came less than usual (facts.ts missedUsualVisit). */
  readonly missedUsualVisit: boolean;
  /** A film was played on her television that week (facts.ts watchedFilms). */
  readonly watchedFilms: boolean;
}

/** The actions this week allows, in menu order. A note, and nothing, are always open. */
export function allowedActions(ctx: SuggestionContext): SuggestedAction[] {
  return SUGGESTED_ACTIONS.filter((action) => {
    if (action === 'arrange_visit') return ctx.missedUsualVisit;
    if (action === 'watch_together') return ctx.watchedFilms;
    return true;
  });
}

/** What a suggestion that fails a check becomes: "nothing", in words that claim nothing about the week. */
export const NO_SUGGESTION: BriefSuggestion = { action: 'nothing', reason: 'Nothing to suggest this week.' };

export type SuggestionVerdict =
  | { readonly ok: true; readonly suggestion: BriefSuggestion }
  | { readonly ok: false; readonly why: 'not_a_suggestion' | 'action_not_allowed' | 'guardian' | 'unsupported' };

/**
 * Code's judgement of the suggester's answer. `checkText` is the week's own
 * number-and-comparison check (weekFacts.ts checkNarrative, bound to this
 * week's facts), so the reason may use only numbers the facts gave.
 */
export function judgeSuggestion(
  raw: unknown,
  ctx: SuggestionContext,
  policy: HouseholdPolicy,
  checkText: (text: string) => boolean,
  /** The household's own people, by name (policy foreign.ts). */
  people: readonly string[] = [],
): SuggestionVerdict {
  const suggestion = readBriefSuggestion(raw);
  if (!suggestion) return { ok: false, why: 'not_a_suggestion' };
  if (!allowedActions(ctx).includes(suggestion.action)) return { ok: false, why: 'action_not_allowed' };
  if (!checkText(suggestion.reason)) return { ok: false, why: 'unsupported' };
  if (!clearForFamily(suggestion.reason, policy, { people }).cleared) return { ok: false, why: 'guardian' };
  return { ok: true, suggestion };
}

/** The suggester's structured output (Strands structuredOutputSchema): one action, one short reason. */
export const suggestionSchema = z
  .object({
    action: z.enum(SUGGESTED_ACTIONS).describe('One thing the family member could do.'),
    reason: z.string().min(1).max(BRIEF_REASON_MAX_CHARS).describe(`One short sentence, under ${BRIEF_REASON_MAX_CHARS} characters, grounded in the facts.`),
  })
  .describe('The one suggestion for the family member about this week.');

export const SUGGESTER_SYSTEM_PROMPT = `You help a distant family member decide one small thing to do after reading their relative's week.

You are given the week's facts, the paragraph already written from them, and the actions this week allows. Choose exactly one of the allowed actions:
- send_note: send a short note to her television.
- arrange_visit: arrange a visit (only offered when somebody came to the door less often than usual when a regular visitor was expected).
- watch_together: invite her to watch a film together (only offered when she watched a film this week).
- nothing: the week needs nothing more than reading it.

Rules, all mandatory:
- Choose only from the allowed actions.
- The reason is one short sentence, under ${BRIEF_REASON_MAX_CHARS} characters, that rests only on the facts given. Use only the numbers that appear in them, or none.
- Never give medical, financial or care advice. Never guess how anyone feels, or why anything happened.
- Plain, warm, unsensational words. No exclamation.`;
