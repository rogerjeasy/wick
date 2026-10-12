/**
 * The home screen's quiet row: one card that has been shown at two breaks,
 * was left both times, and is not shown a third (NaturalBreakEngine Rule 3).
 * It is not gone. It waits here, in one plain line, until it is asked for.
 *
 * Pure: the words for each kind of card.
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
    default:
      return 'Something is waiting for you.';
  }
}
