/**
 * The home screen's quiet row: one card that has been shown at two breaks,
 * was left both times, and is not shown a third (NaturalBreakEngine Rule 3).
 * It is not gone. It waits here, in one plain line, until it is asked for.
 *
 * Pure: the words for each kind of card, and what Back does to one that
 * was opened.
 */
import type { QueuedCard } from '@wick/contracts';

export function waitingLine(queued: QueuedCard): string {
  const card = queued.card;
  switch (card.type) {
    case 'MESSAGE':
      return `A note from ${card.fromName} is waiting.`;
    case 'WEEK':
      return 'Your week is ready to read.';
    case 'CIRCLE':
      return `${card.personName} would like to join your family circle.`;
    case 'SHARING':
      return 'What your family can see is ready to look at.';
    // Not the sentence itself: the home screen can be read by anyone in the room.
    case 'TELL':
      return 'Wick has a question for you.';
    case 'WATCH':
      return card.headline;
    // Never waits (home/light.ts unaskedLightCards); here only so every card has its line.
    case 'LIGHT':
      return card.headline;
    // Not who came or when: the home screen can be read by anyone in the room.
    case 'VISIT':
      return 'Wick has a question for you.';
    // What was said about a request of her own (home/reach.ts): the card's own sentence.
    case 'REACH':
      return card.headline;
    default:
      return 'Something is waiting for you.';
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
