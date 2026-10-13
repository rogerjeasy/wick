/**
 * The cards this build can draw.
 *
 * The server may learn a new kind of card before a television is updated.
 * A card this build has no view for used to be an invisible card that took
 * the remote: nothing was drawn, yet it was "on screen" — the home screen
 * gave up its focus to it, a film was held for it, and the server was told
 * it had been shown. So an old build fails safe instead: a card of a kind it
 * does not know is never kept (headless/QueueStore.ts), which means it is
 * never picked, shown, counted or waited for. The server still holds it, and
 * sends it again to a build that knows it.
 *
 * One entry for every member of the contract's `Card`: adding a kind of
 * card there does not compile here until it is listed — and
 * cards/__tests__/knownCards.test.ts holds this list to the views
 * CardRenderer.tsx has.
 *
 * Pure and RN-import-free.
 */
import type { Card, QueuedCard } from '@wick/contracts';

const KNOWN: Readonly<Record<Card['type'], true>> = {
  DOOR: true,
  MESSAGE: true,
  WEEK: true,
  SHARING: true,
  CIRCLE: true,
  TELL: true,
  WATCH: true,
  LIGHT: true,
  REACH: true,
  VISIT: true,
  LANGUAGE: true,
  PHOTO: true,
};

export const KNOWN_CARD_TYPES: readonly Card['type'][] = Object.keys(KNOWN) as Card['type'][];

/** Whether this is a card, of a kind this build has a view for. Anything else — and anything that is not a card — is not. */
export function isKnownCard(queued: unknown): queued is QueuedCard {
  if (typeof queued !== 'object' || queued === null) return false;
  const { id, card } = queued as { id?: unknown; card?: unknown };
  if (typeof id !== 'string' || typeof card !== 'object' || card === null) return false;
  const type = (card as { type?: unknown }).type;
  // Not `in`: "constructor" is a property of every object, and no card. (And not Object.hasOwn, which the television's engine is not known to have.)
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(KNOWN, type);
}
