/**
 * Watch together (packages/contracts/src/watch.ts): the invitation, "… is
 * ready to watch with you", the question at the credits, and what the other
 * person answered. The server wrote every word and every button
 * (services/mcp-server/src/tools, edge-device watch-together.mjs); this only
 * renders it.
 *
 * The press travels as a card_action like any other, and the card's id
 * names the session. The one press that does something on this television
 * — "Start the film" — is decided in cardActions.ts and carried out in
 * App.tsx.
 */
import * as React from 'react';
import { CalmCard } from '@wick/vega-calm-ui';
import type { WatchCard as WatchCardModel } from '@wick/contracts';

export interface WatchCardProps {
  readonly card: WatchCardModel;
  readonly onAction: (id: string) => void;
}

export function WatchCardView({ card, onAction }: WatchCardProps): React.JSX.Element {
  return <CalmCard headline={card.headline} detail={card.detail} actions={card.actions} onAction={onAction} />;
}
