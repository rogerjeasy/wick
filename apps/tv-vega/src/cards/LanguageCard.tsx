/**
 * The television speaks her language (packages/contracts/src/language.ts):
 * the organiser has asked for another language, and the resident says yes
 * or no with one press. Nothing changes until she does.
 *
 * The server wrote every word, in both languages at once — the question and
 * the first button in the language asked for, the second button in the one
 * the television speaks now — so this only renders it, like the Circle
 * card, and none of it comes from the television's own words
 * (words/words.ts). It is the one card that looks the same whichever
 * language the television is in.
 *
 * It waits for a natural break like any note (INV-5), and either answer
 * finishes it (cardActions.ts). After her yes the home message carries the
 * new language, the television's own words change with it, and the cards it
 * holds are asked for again in that language (transport/startCardChannel.ts).
 *
 * Drawn compact, with six lines for its detail in place of five: see
 * languageDetail.ts for why, and what holds it to fitting the screen.
 */
import * as React from 'react';
import { CalmCard } from '@wick/vega-calm-ui';
import type { LanguageCard as LanguageCardModel } from '@wick/contracts';
import { LANGUAGE_CARD_COMPACT, LANGUAGE_DETAIL_LINES } from './languageDetail.js';

export interface LanguageCardProps {
  readonly card: LanguageCardModel;
  readonly onAction: (id: string) => void;
}

export function LanguageCardView({ card, onAction }: LanguageCardProps): React.JSX.Element {
  return (
    <CalmCard
      headline={card.headline}
      detail={card.detail}
      actions={card.actions}
      onAction={onAction}
      compact={LANGUAGE_CARD_COMPACT}
      detailLines={LANGUAGE_DETAIL_LINES}
    />
  );
}
