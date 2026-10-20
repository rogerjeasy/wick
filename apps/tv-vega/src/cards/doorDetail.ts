/**
 * What the Door Card's reserved detail slot (TwoPhaseCard) shows, given
 * whatever has arrived so far — pure and RN-import-free, so it is testable
 * without touching DoorCard.tsx's native imports. See that file's own
 * comment on why the view itself carries no test.
 *
 * A real observation beats an inference: card.description (Phase 2b, the
 * vision model looking at an actual frame) always wins over card.match
 * (M4, a schedule guess available from Phase 1). The match is what shows
 * while the resident is still waiting for the picture — and when no
 * sentence comes at all — so it says only that the visitor is due.
 */
import { DEFAULT_LANGUAGE, type DoorCard, type HouseholdLanguage } from '@wick/contracts';
import { words } from '../words/words.js';

export function doorDetailText(card: DoorCard, language: HouseholdLanguage = DEFAULT_LANGUAGE): string | undefined {
  // The server's words, already in her language.
  if (card.description) return card.description;
  if (card.match) {
    // The television's own sentence around a name (words/words.ts): when the visitor is due, never who has come. The
    // name is the family's own words, and may begin a sentence in lower case ("the plumber").
    const said = words(language)(card.match.expectedToday ? 'door.looksLikeExpected' : 'door.looksLike', { name: card.match.name });
    return said.charAt(0).toUpperCase() + said.slice(1);
  }
  return undefined;
}
