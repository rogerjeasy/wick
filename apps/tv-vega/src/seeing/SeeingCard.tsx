/**
 * The Easier to see card (seeing.ts): three buttons, exactly — "Larger
 * text", "Higher contrast", "Back" — each of the first two saying how its
 * setting stands. A press on one changes the whole television at once,
 * this card included, so what she has done is in front of her the moment
 * she has done it.
 *
 * It decides nothing: a press goes to the app (ResidentApp.tsx), which
 * holds the card's one second (press/settle.ts) like any card's and hands
 * the press to the provider (SeeingProvider.tsx). The focus stays on the
 * button she pressed.
 */
import * as React from 'react';
import { CalmCard, CalmPresence } from '@wick/vega-calm-ui';
import type { HouseholdLanguage } from '@wick/contracts';
import { words } from '../words/words.js';
import { useSeeing } from './SeeingProvider.js';
import { seeingActions } from './seeing.js';

export interface SeeingCardProps {
  readonly language: HouseholdLanguage;
  /** The button she last pressed here: it keeps the focus as the screen is drawn again. */
  readonly focusId?: string | undefined;
  readonly onAction: (actionId: string) => void;
}

export function SeeingCard({ language, focusId, onAction }: SeeingCardProps): React.JSX.Element {
  const say = words(language);
  const { preferences } = useSeeing();
  // Arriving like any card: rising into place in 200ms, or at once with reduced motion.
  return (
    <CalmPresence shown rises>
      <CalmCard
        headline={say('seeing.headline')}
        detail={say('seeing.detail')}
        actions={seeingActions(preferences, say)}
        initialFocusId={focusId}
        onAction={onAction}
      />
    </CalmPresence>
  );
}
