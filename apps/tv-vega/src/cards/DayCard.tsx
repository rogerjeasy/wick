/**
 * S3 — the Day Card. At most three things worth remembering, at the next
 * natural break, never mid-programme (S2 gates when this ever mounts).
 *
 * Three items, never four — enforced at render, the same way CalmCard
 * enforces its own floor, via assertItemLimit (constraints.ts, written
 * ahead of this component specifically for the Day Card — see its own
 * comment: "Principle 6 again, for the Day Card's items").
 *
 * One action only: acknowledging is the whole interaction, the same shape
 * as WeekCard.tsx's INV-7 surface. Nothing here is individually actionable —
 * a family message teaser (Day agent's rubric 3, see
 * services/agent/src/agents/day/index.ts) is answered on its own MessageCard
 * (M3), not from here.
 */
import * as React from 'react';
import type { DayCard as DayCardModel } from '@wick/contracts';
import { CalmCard, assertItemLimit } from '@wick/vega-calm-ui';

export interface DayCardProps {
  readonly card: DayCardModel;
  readonly onAction: (id: string) => void;
}

/**
 * One Text block, not one per item: CalmCard's slot order is
 * children-then-headline-then-detail, and `detail` is exactly the "a block
 * of prose beneath the headline" shape the other single-string cards
 * (WeekCard) already use — bullets joined by newlines get CalmCard's own
 * 32pt/7:1 detail styling for free, with no second component to keep
 * in sync with the accessibility floor.
 */
function itemsText(card: DayCardModel): string {
  return card.items.map((item) => `•  ${item.text}`).join('\n');
}

export function DayCardView({ card, onAction }: DayCardProps): React.JSX.Element {
  assertItemLimit(card.items.length);

  return <CalmCard headline={card.greeting} detail={itemsText(card)} actions={card.actions} onAction={onAction} />;
}
