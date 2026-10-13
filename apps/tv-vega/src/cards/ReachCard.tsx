/**
 * Hold for Sarah (packages/contracts/src/reach.ts): the card her two-second
 * hold on OK brings, and every later state of the same request — who was
 * asked to ring her, who is next, what was answered. The server wrote every
 * word (edge-device reach.mjs for the offer, the agent plane after her
 * press); this only renders it.
 *
 * "Yes, ask Sarah" and "Just say hello" leave the card where it is
 * (cardActions.ts): what happened is written onto it a moment later.
 */
import * as React from 'react';
import { CalmCard } from '@wick/vega-calm-ui';
import type { ReachCard as ReachCardModel } from '@wick/contracts';

export interface ReachCardProps {
  readonly card: ReachCardModel;
  readonly onAction: (id: string) => void;
}

export function ReachCardView({ card, onAction }: ReachCardProps): React.JSX.Element {
  return <CalmCard headline={card.headline} detail={card.detail} actions={card.actions} onAction={onAction} />;
}
