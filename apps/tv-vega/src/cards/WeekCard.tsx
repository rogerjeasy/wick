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
import type { HouseholdLanguage, WeekCard as WeekCardModel } from '@wick/contracts';
import { words } from '../words/words.js';

export interface WeekCardProps {
  readonly card: WeekCardModel;
  /** For the two words that are this television's own; the week itself is the server's, already in her language. */
  readonly language: HouseholdLanguage;
  readonly onAction: (id: string) => void;
}

export function WeekCardView({ card, language, onAction }: WeekCardProps): React.JSX.Element {
  return (
    <CalmCard headline={words(language)('week.headline')} detail={card.text} actions={card.actions} onAction={onAction} />
  );
}
