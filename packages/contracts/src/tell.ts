/**
 * "Shall I tell Sarah?" — the resident decides whether a difference leaves
 * the house.
 *
 * Wick notices when a day is unlike this household's usual (the Rhythm
 * pillar's different.ts). It used to tell the family whenever they asked.
 * Now it asks the resident first, on their own television, showing the very
 * sentence the family would be told. Only "Tell Sarah" makes it readable;
 * until then, and after "Keep it to myself", the family is told nothing —
 * not even that there was something.
 *
 * One row per difference: `HH#<household>` / `TELL#<differenceId>`, written
 * when the resident is asked (services/agent agents/tell) and answered by
 * their press. The family's get_whats_different reads the rows answered
 * "tell", and nothing else.
 */
export const TELL_SK_PREFIX = 'TELL#';

export type TellAnswer = 'tell' | 'keep';

/** The Tell card's actions. One press answers; either finishes the card. */
export const TELL_ACTIONS = {
  tell: 'tell_family',
  keep: 'keep_private',
} as const;

/** What a press means, or undefined for a press that is not one of the card's two. */
export function tellAnswerOf(action: unknown): TellAnswer | undefined {
  if (action === TELL_ACTIONS.tell) return 'tell';
  if (action === TELL_ACTIONS.keep) return 'keep';
  return undefined;
}

const TELL_CARD_PREFIX = 'tell-';

/** Deterministic, like the Week and Circle cards: the press names the difference without the television holding anything else about it. */
export function tellCardId(differenceId: string): string {
  return `${TELL_CARD_PREFIX}${differenceId}`;
}

/** The difference a Tell card asks about, or undefined for any other card. */
export function differenceIdFromTellCardId(cardId: string): string | undefined {
  return cardId.startsWith(TELL_CARD_PREFIX) && cardId.length > TELL_CARD_PREFIX.length
    ? cardId.slice(TELL_CARD_PREFIX.length)
    : undefined;
}
