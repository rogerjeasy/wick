/**
 * The home screen's quiet row: one card that has been shown at two breaks,
 * was left both times, and is not shown a third (NaturalBreakEngine Rule 3).
 * It is not gone. It waits here, in one plain line, until it is asked for.
 *
 * Pure: the words for each kind of card, in her language (words/words.ts),
 * and what Back does to one that was opened.
 */
import { DEFAULT_LANGUAGE, type HouseholdLanguage, type QueuedCard } from '@wick/contracts';
import { words } from '../words/words.js';

export function waitingLine(queued: QueuedCard, language: HouseholdLanguage = DEFAULT_LANGUAGE): string {
  const say = words(language);
  const card = queued.card;
  switch (card.type) {
    case 'MESSAGE':
      return say('waiting.note', { name: card.fromName });
    case 'WEEK':
      return say('waiting.week');
    case 'CIRCLE':
      return say('waiting.circle', { name: card.personName });
    case 'SHARING':
      return say('waiting.sharing');
    // Not the sentence itself: the home screen can be read by anyone in the room.
    case 'TELL':
      return say('waiting.question');
    case 'WATCH':
      return card.headline;
    // Never waits (home/light.ts unaskedLightCards); here only so every card has its line.
    case 'LIGHT':
      return card.headline;
    // Not who came or when: the home screen can be read by anyone in the room.
    case 'VISIT':
      return say('waiting.question');
    // The server's own question, which is written in the language asked for
    // (packages/contracts language.ts): the television's language now may be
    // the one she does not read, and this line is how she finds the card.
    case 'LANGUAGE':
      return card.headline;
    // What was said about a request of her own (home/reach.ts): the card's own sentence.
    case 'REACH':
      return card.headline;
    default:
      return say('waiting.something');
  }
}

/**
 * Whether Back should put an opened waiting card back to waiting.
 *
 * Opening one is a look, not a promise to answer. Without this, Back on
 * the home screen does what it does with nothing open: it leaves Wick.
 *
 * Only for the card the resident opened, and only while it is the thing in
 * front: with the door over it, or the door camera open, Back is theirs.
 */
export function backClosesOpened(on: { readonly openedId: string | null; readonly shownId: string | null; readonly liveOpen: boolean }): boolean {
  return on.openedId !== null && on.shownId === on.openedId && !on.liveOpen;
}
