/**
 * Which of the family home screen's lines are drawn while a card is
 * showing, and whether the wave is. Pure: FamilyHome.tsx measures what it
 * has laid out — where each line ends, where the card begins — and draws
 * what this says.
 *
 * A card sits over the bottom of the screen, as every card does on the
 * resident's television, and the tallest of them reaches well up it. A
 * line the card would reach is not drawn at all: never half of one, and
 * never the specks of one showing at the card's rounded corner (seen on
 * the Fire OS emulator, 2026-10-13). The lines are in the order of what
 * must not be lost (familyScreen.ts `familyLines`), so what gives way is
 * the last of them; and once one is left out, so is everything under it.
 *
 * Measured, not guessed: how many lines a sentence takes, and how tall a
 * card comes out, is the television's to know once it has laid them out.
 */

/**
 * How far a line must end above the card's top edge to be drawn. The gap
 * between rows on this screen — and enough that nothing of a line is near
 * the card's rounded corner.
 */
export const CARD_CLEARANCE_DP = 8;

/** Whose home, and whose television: drawn before a new card has been measured, since they fit above every card the server sends. */
const ALWAYS_SAID = 2;

export type CardPlace =
  | { readonly showing: false }
  /** `top`: where the card begins, in dp from the top of the screen — undefined until it has been measured. */
  | { readonly showing: true; readonly top: number | undefined };

/**
 * For each row, top first, whether it is drawn.
 *
 * @param rowBottoms  where each row ends, in dp from the top of the screen — undefined for one not yet measured
 */
export function rowsDrawn(rowBottoms: readonly (number | undefined)[], cardAt: CardPlace): boolean[] {
  if (!cardAt.showing) return rowBottoms.map(() => true);
  // A card just arrived, and where it begins is not known yet: say whose
  // screen this is, and nothing that might turn out to be under it.
  if (cardAt.top === undefined) return rowBottoms.map((_bottom, row) => row < ALWAYS_SAID);

  const top = cardAt.top;
  let clear = true;
  return rowBottoms.map((bottom) => {
    clear = clear && bottom !== undefined && bottom + CARD_CLEARANCE_DP <= top;
    return clear;
  });
}

/**
 * Whether the wave — its button, or the sentence that stands in for it —
 * is drawn. Only when no card is showing: under a card it pushed the card
 * up over the lines above (with a film card, over everything but the
 * heading), and beside a card's answers it is not something to press
 * unread. It is back the moment the card has gone.
 */
export function waveDrawn(showing: 'nothing' | 'card' | 'said'): boolean {
  return showing === 'nothing';
}
