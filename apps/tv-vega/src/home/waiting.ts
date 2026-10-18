/**
 * The home screen's quiet row: one card that has been shown at two breaks,
 * was left both times, and is not shown a third (NaturalBreakEngine Rule 3),
 * or a note she put aside with Back (putAway). It is not gone. It waits
 * here, in one plain line, until it is asked for.
 *
 * Pure: the words for each kind of card, in her language (words/words.ts),
 * and what Back does to one that was opened.
 */
import { DEFAULT_LANGUAGE, MAX_CARD_SHOWS, NOTE_ACTIONS, type Card, type HouseholdLanguage, type QueuedCard } from '@wick/contracts';
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
    // Who it is from, and nothing of the picture: the home screen can be read by anyone in the room.
    case 'PHOTO':
      return say('waiting.photo', { name: card.fromName });
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

/**
 * What Back does on a card that came to her rather than one she opened —
 * the door over her film, a note at a break. It is that card's own "Not
 * now", pressed as its button is (and so by the same first-second settle);
 * on a note, which has no such button, "later"; on any other card with
 * none, nothing. Either way Back is taken: it never falls through to the
 * film underneath, which it used to end, nor out of Wick.
 */
export function backOnShownCard(card: Card | undefined): string | undefined {
  // A note's buttons are all replies, so Back is its own "later" (NOTE_ACTIONS): never a reply said for her.
  if (card?.type === 'MESSAGE') return NOTE_ACTIONS.later;
  return card?.actions.find((action) => action.kind === 'dismiss')?.id;
}

/** Whether this press puts a note aside to her home screen's quiet line (putAway), rather than answering it. */
export function putsAway(card: Card, actionId: string): boolean {
  return card.type === 'MESSAGE' && actionId === NOTE_ACTIONS.later;
}

/**
 * A note she said "later" to: the same note, counted as having had its two
 * showings, so it is not brought to her again by itself and waits on the
 * home screen at once (BreakController.waiting). The server counts it so
 * too, for every television of the home (note-reply.mjs markNoteSeen).
 */
export function putAway(queued: QueuedCard): QueuedCard {
  return { ...queued, shownCount: Math.max(queued.shownCount, MAX_CARD_SHOWS) };
}
