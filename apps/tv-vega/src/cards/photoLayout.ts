/**
 * How a picture from the family is drawn on its card (PhotoCard.tsx) — pure
 * and RN-import-free, so it is tested without the view, like doorDetail.ts
 * and languageDetail.ts.
 *
 * The picture is the card: it is as large as the card allows while the
 * headline ("A picture from Sarah.") and both buttons stay on the screen at
 * 32pt. It sits beside the words, as the door's picture does — above them
 * it could be 266dp tall; beside them it is 320.
 *
 * The numbers, on Vega's 960x540dp screen:
 *
 *   - The card is compact (less card around the words, never smaller
 *     words) and may be 476dp tall: the screen less 32dp above and below.
 *     Its padding (2 x 24), the gap above the buttons (16) and the row of
 *     buttons (84.8) leave 327dp; the picture's box is 320.
 *   - The card is 816dp wide inside its padding. The box is 432 wide, so a
 *     picture four by three — most of what a telephone takes — is shown at
 *     the box's full height: 427x320. A wide one (16:9) is 432x243, a tall
 *     one (3:4) 240x320. The words have the other 360dp.
 *   - In 360dp at 32pt the headline takes one line or two, and the notice
 *     that her mantelpiece is full four; seven lines are as tall as the
 *     picture, so the notice is given five and the card is no taller for it.
 *
 * The whole picture is shown, on the ground colour, never cropped: it is
 * somebody's face (mantel/Picture.tsx). The card checks its own height as it
 * is drawn (packages/vega-calm-ui constraints.ts assertCardFits), and
 * cards/__tests__/photoLayout.test.ts holds the rest.
 */

/** Tighter spacing and the headline at body size: still nothing under 32pt. */
export const PHOTO_CARD_COMPACT = true;

/** The picture's box. The picture is fitted inside it, whole. */
export const PHOTO_BOX = { width: 432, height: 320 } as const;

/** What is left of the card's width for the words: 960 less the card layer's 2 x 48, the card's 2 x 24, the box and the 24 between. */
export const PHOTO_TEXT_WIDTH_DP = 960 - 2 * 48 - 2 * 24 - PHOTO_BOX.width - 24;

/** The most lines the notice is given: with a two-line headline, as tall as the picture. */
export const PHOTO_NOTICE_LINES = 5;

/**
 * The address a picture is fetched from: https, or none. An address minted
 * for this television lives an hour (packages/contracts mantel.ts); a card
 * without one, or with anything else in its place, shows the calm line
 * instead — and its buttons still work.
 */
export function pictureAddress(url: unknown): string | undefined {
  return typeof url === 'string' && url.startsWith('https://') ? url : undefined;
}
