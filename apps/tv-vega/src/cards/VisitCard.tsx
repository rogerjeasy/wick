/**
 * The visit, witnessed (packages/contracts/src/visit.ts): what the door
 * noted of a regular visitor's visit, and the question whether it is
 * right. The server wrote every word (services/agent agents/visit); this
 * only renders it. Either press finishes the card (cardActions.ts).
 */
import * as React from 'react';
import { CalmCard } from '@wick/vega-calm-ui';
import type { VisitCard as VisitCardModel } from '@wick/contracts';

export interface VisitCardProps {
  readonly card: VisitCardModel;
  readonly onAction: (id: string) => void;
}

export function VisitCardView({ card, onAction }: VisitCardProps): React.JSX.Element {
  return <CalmCard headline={card.headline} detail={card.detail} actions={card.actions} onAction={onAction} />;
}
