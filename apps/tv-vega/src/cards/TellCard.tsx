/**
 * "Shall I tell Sarah?" on the resident's own screen: something about today
 * is unlike this household's usual, and nothing about it reaches the family
 * unless the resident says so. The detail is the very sentence the family
 * would be told. The server wrote every word (services/agent
 * rhythm/tell.ts); this only renders it.
 *
 * The press travels as a card_action like any other, and either answer
 * finishes the card (cardActions.ts): the resident is asked once.
 */
import * as React from 'react';
import { CalmCard } from '@wick/vega-calm-ui';
import type { TellCard as TellCardModel } from '@wick/contracts';

export interface TellCardProps {
  readonly card: TellCardModel;
  readonly onAction: (id: string) => void;
}

export function TellCardView({ card, onAction }: TellCardProps): React.JSX.Element {
  return <CalmCard headline={card.headline} detail={card.detail} actions={card.actions} onAction={onAction} />;
}
