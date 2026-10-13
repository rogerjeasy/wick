/**
 * How the question about her language is drawn (LanguageCard.tsx) — pure
 * and RN-import-free, so it is tested without the view, like doorDetail.ts.
 *
 * The question is asked in both languages at once (packages/contracts
 * language.ts), because she may read only one of them. So its detail is the
 * longest a card carries — up to 240 characters — and all of it has to be
 * on the screen: the half that was cut off might be the half she reads.
 *
 * A card's detail is cut at five lines, so no producer can push the buttons
 * off the screen, and at 32pt 240 characters can need a sixth. The room for
 * it comes from less card around the words — the compact card, whose
 * headline is written at body size — and never from smaller words. The
 * card checks, as it is drawn, that it still fits the screen at that
 * (packages/vega-calm-ui constraints.ts assertCardFits);
 * cards/__tests__/languageDetail.test.ts holds the longest question the
 * server can write — it cuts a long name, never the sentence — and 240
 * characters of sentences like its own, to fit in six lines.
 */

/** Tighter spacing and the headline at body size: still nothing under 32pt. */
export const LANGUAGE_CARD_COMPACT = true;

/** One more line than a card usually gets (vega-calm-ui `limits.maxDetailLines`). */
export const LANGUAGE_DETAIL_LINES = 6;
