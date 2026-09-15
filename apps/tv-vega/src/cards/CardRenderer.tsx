/**
 * The single renderer for all three card types.
 *
 * Non-negotiable, from docs/WICK.md Part 5 — enforced by @wick/vega-calm-ui:
 *   - minimum 32pt type, contrast >= 7:1
 *   - at most 3 actions, reachable with D-pad + OK only, no text entry
 *   - never auto-dismiss, never a timer (Principle 9)
 *   - no red, no badges, no beeps
 *   - animation <= 200ms ease-out, nothing that startles
 *   - DOOR renders in the lower third and never pauses, covers or silences
 */
import * as React from 'react';
import type { Card } from '@wick/contracts';
import { DoorCardView } from './DoorCard.js';

export interface CardRendererProps {
  readonly card: Card;
  readonly onAction: (cardId: string, actionId: string) => void;
}

export function CardRenderer({ card, onAction }: CardRendererProps): React.JSX.Element | null {
  const handle = (actionId: string) => onAction(card.id, actionId);

  switch (card.type) {
    case 'DOOR':
      return <DoorCardView card={card} onAction={handle} />;

    // TODO(S3): DAY full-screen presentation, at most 3 items.
    // TODO(S5): MESSAGE with audio playback and three drafted replies.
    //
    // Returning null is deliberate rather than lazy: an unbuilt card type must
    // show nothing at all, not a half-built surface. A card the resident cannot
    // act on is worse than silence.
    case 'DAY':
    case 'MESSAGE':
      return null;
  }
}
