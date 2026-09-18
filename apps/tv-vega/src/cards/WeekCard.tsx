/**
 * INV-7's television surface — the resident's own week, on their own
 * screen, before Sarah can ask Alexa about it. Pressing OK is the whole
 * interaction: the resulting card_action reaches route.mjs
 * (services/edge-device/lambda/route.mjs), which sets
 * WeekNarrative.residentSeenAt from the card's id alone (`week-<isoWeek>`)
 * — that write is what actually opens get_week_narrative.ts's gate for
 * the family. Nothing on this screen, or anywhere in this component,
 * talks to that gate directly.
 */
import * as React from 'react';
import { CalmCard } from '@wick/vega-calm-ui';
import type { WeekCard as WeekCardModel } from '@wick/contracts';

export interface WeekCardProps {
  readonly card: WeekCardModel;
  readonly onAction: (id: string) => void;
}

export function WeekCardView({ card, onAction }: WeekCardProps): React.JSX.Element {
  return (
    <CalmCard headline="Your week." detail={card.text} actions={card.actions} onAction={onAction} />
  );
}
