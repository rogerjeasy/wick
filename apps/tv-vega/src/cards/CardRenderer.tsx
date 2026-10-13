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
 *
 * Nearly every word on a card is the server's, and arrives in her language.
 * `language` is for the few that are this television's own
 * (words/words.ts): the Week card's headline, who a note is from, who the
 * door looks like.
 *
 * A card of a kind this build does not know draws nothing. It should never
 * get here — the queue does not keep one (cards/knownCards.ts) — but a card
 * that drew nothing while holding the remote is what this default is the
 * last guard against.
 */
import * as React from 'react';
import type { Card, HouseholdLanguage } from '@wick/contracts';
import { CircleCardView } from './CircleCard.js';
import { DoorCardView } from './DoorCard.js';
import { LanguageCardView } from './LanguageCard.js';
import { LightCardView } from './LightCard.js';
import { MessageCardView } from './MessageCard.js';
import { ReachCardView } from './ReachCard.js';
import { SharingCardView } from './SharingCard.js';
import { TellCardView } from './TellCard.js';
import { VisitCardView } from './VisitCard.js';
import { WatchCardView } from './WatchCard.js';
import { WeekCardView } from './WeekCard.js';

export interface CardRendererProps {
  readonly card: Card;
  /** The language she chose, for the words that are this television's own. */
  readonly language: HouseholdLanguage;
  readonly onAction: (cardId: string, actionId: string) => void;
}

/** Nothing — and, to the compiler, unreachable: a kind of card added to the contract must be given a view above. */
function unknownCard(_card: never): null {
  return null;
}

export function CardRenderer({ card, language, onAction }: CardRendererProps): React.JSX.Element | null {
  const handle = (actionId: string) => onAction(card.id, actionId);

  switch (card.type) {
    case 'DOOR':
      return <DoorCardView card={card} language={language} onAction={handle} />;

    case 'MESSAGE':
      return <MessageCardView card={card} language={language} onAction={handle} />;

    case 'WEEK':
      return <WeekCardView card={card} language={language} onAction={handle} />;

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

    case 'REACH':
      return <ReachCardView card={card} onAction={handle} />;

    case 'VISIT':
      return <VisitCardView card={card} onAction={handle} />;

    case 'LANGUAGE':
      return <LanguageCardView card={card} onAction={handle} />;

    default:
      return unknownCard(card);
  }
}
