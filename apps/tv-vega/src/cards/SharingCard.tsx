/**
 * "What Sarah sees" — trust promise 2 on the resident's own television.
 * The server builds every word and button from the live household policy
 * (services/edge-device/lambda/sharing.mjs) and replaces this card in place
 * after each press; this view only renders it. The device renders and
 * never decides.
 */
import * as React from 'react';
import { CalmCard } from '@wick/vega-calm-ui';
import type { SharingCard as SharingCardModel } from '@wick/contracts';

export interface SharingCardProps {
  readonly card: SharingCardModel;
  readonly onAction: (id: string) => void;
}

export function SharingCardView({ card, onAction }: SharingCardProps): React.JSX.Element {
  return <CalmCard headline={card.headline} detail={card.detail} actions={card.actions} onAction={onAction} />;
}
