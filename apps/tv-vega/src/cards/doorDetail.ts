/**
 * What the Door Card's reserved detail slot (TwoPhaseCard) shows, given
 * whatever has arrived so far — pure and RN-import-free, so it is testable
 * without touching DoorCard.tsx's native imports. See that file's own
 * comment on why the view itself carries no test.
 *
 * A real observation beats an inference: card.description (Phase 2b, the
 * vision model looking at an actual frame) always wins over card.match
 * (M4, a schedule guess available from Phase 1). The match is what shows
 * while the resident is still waiting for the picture.
 */
import type { DoorCard } from '@wick/contracts';

export function doorDetailText(card: DoorCard): string | undefined {
  if (card.description) return card.description;
  if (card.match) {
    return card.match.expectedToday
      ? `This looks like ${card.match.name} — expected around now.`
      : `This looks like ${card.match.name}.`;
  }
  return undefined;
}
