/**
 * INV-9's television surface: someone would like to join the family circle,
 * and the resident says yes or no with one press. The server wrote every
 * word (services/mcp-server/src/accounts/circle.ts); this only renders it.
 *
 * The press travels as a card_action like any other. route.mjs
 * (services/edge-device/lambda) reads who it is about from the card's id
 * and records the answer on that person's membership — nothing here knows
 * anything about the person but their name.
 */
import * as React from 'react';
import { CalmCard } from '@wick/vega-calm-ui';
import type { CircleCard as CircleCardModel } from '@wick/contracts';

export interface CircleCardProps {
  readonly card: CircleCardModel;
  readonly onAction: (id: string) => void;
}

export function CircleCardView({ card, onAction }: CircleCardProps): React.JSX.Element {
  return <CalmCard headline={card.headline} detail={card.detail} actions={card.actions} onAction={onAction} />;
}
