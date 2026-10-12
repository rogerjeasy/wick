/**
 * Her own light (packages/contracts/src/light.ts): whether it is on, who
 * can see it, who looked in today, and the one button that puts it out for
 * the day or lights it again. Asked for from the home screen. The server
 * wrote every word (edge-device light.mjs); this only renders it.
 *
 * Either press finishes the card (cardActions.ts), and so does Back
 * (App.tsx): leaving it as it is must never be harder than changing it.
 */
import * as React from 'react';
import { CalmCard } from '@wick/vega-calm-ui';
import type { LightCard as LightCardModel } from '@wick/contracts';

export interface LightCardProps {
  readonly card: LightCardModel;
  readonly onAction: (id: string) => void;
}

export function LightCardView({ card, onAction }: LightCardProps): React.JSX.Element {
  return <CalmCard headline={card.headline} detail={card.detail} actions={card.actions} onAction={onAction} />;
}
