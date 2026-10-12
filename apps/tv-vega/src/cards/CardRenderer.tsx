/**
 * The single renderer for every card type.
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
import { CircleCardView } from './CircleCard.js';
import { DoorCardView } from './DoorCard.js';
import { LightCardView } from './LightCard.js';
import { MessageCardView } from './MessageCard.js';
import { SharingCardView } from './SharingCard.js';
import { TellCardView } from './TellCard.js';
import { WatchCardView } from './WatchCard.js';
import { WeekCardView } from './WeekCard.js';

export interface CardRendererProps {
  readonly card: Card;
  readonly onAction: (cardId: string, actionId: string) => void;
}

export function CardRenderer({ card, onAction }: CardRendererProps): React.JSX.Element | null {
  const handle = (actionId: string) => onAction(card.id, actionId);

  switch (card.type) {
    case 'DOOR':
      return <DoorCardView card={card} onAction={handle} />;

    case 'MESSAGE':
      return <MessageCardView card={card} onAction={handle} />;

    case 'WEEK':
      return <WeekCardView card={card} onAction={handle} />;

    case 'SHARING':
      return <SharingCardView card={card} onAction={handle} />;

    case 'CIRCLE':
      return <CircleCardView card={card} onAction={handle} />;

    case 'TELL':
      return <TellCardView card={card} onAction={handle} />;

    case 'WATCH':
      return <WatchCardView card={card} onAction={handle} />;

    case 'LIGHT':
      return <LightCardView card={card} onAction={handle} />;
  }
}
