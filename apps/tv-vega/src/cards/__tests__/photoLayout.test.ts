/**
 * The picture card (packages/contracts mantel.ts): how big the picture is,
 * and that the headline and both buttons are still on the screen at 32pt
 * beside it. What it is drawn with is decided in photoLayout.ts and held
 * here; CardRenderer.test.tsx draws PhotoCard.tsx with it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANTEL_FULL_NOTICE, photoCardWords } from '@wick/contracts';
// By path: the package's index brings the components in, and with them the platform.
import { assertCardFits, cardHeightDp } from '../../../../../packages/vega-calm-ui/src/constraints.js';
import { layout, type } from '../../../../../packages/vega-calm-ui/src/tokens.js';
import { PHOTO_BOX, PHOTO_CARD_COMPACT, PHOTO_NOTICE_LINES, PHOTO_TEXT_WIDTH_DP, pictureAddress } from '../photoLayout.js';

/** The card layer's padding either side (ResidentApp.tsx `cardLayer`), on Vega's 960dp-wide screen. */
const CARD_INNER_WIDTH_DP = 960 - 2 * 48 - 2 * layout.compactPaddingDp;
/** The gap between the picture and the words (CalmCard `body`). */
const MEDIA_GAP_DP = 24;
/** Wider than text really is: a line of prose averages under half its type size a letter. */
const GLYPH_WIDTH = 0.55;
const BODY_LINE_DP = type.bodyPt * layout.lineHeight.body;
const charsPerLine = Math.floor(PHOTO_TEXT_WIDTH_DP / (type.bodyPt * GLYPH_WIDTH));

function linesOf(text: string, perLine: number): number {
  let lines = 1;
  let used = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (used > 0 && used + 1 + word.length > perLine) {
      lines += 1;
      used = 0;
    }
    used += (used > 0 ? 1 : 0) + word.length;
  }
  return lines;
}

describe('the picture card — the picture as large as the card allows', () => {
  it('is drawn compact, the picture beside the words, in a box 432dp by 320dp', () => {
    expect(PHOTO_CARD_COMPACT).toBe(true);
    expect(PHOTO_BOX).toEqual({ width: 432, height: 320 });
  });

  it('still fits the screen with its headline and its buttons at 32pt — the rule the card enforces when it is drawn', () => {
    expect(() => assertCardFits({ compact: PHOTO_CARD_COMPACT, mediaHeightDp: PHOTO_BOX.height })).not.toThrow();
    expect(cardHeightDp({ compact: PHOTO_CARD_COMPACT, mediaHeightDp: PHOTO_BOX.height })).toBeLessThanOrEqual(layout.screenHeightDp - 2 * layout.screenMarginDp);
    expect(type.bodyPt).toBeGreaterThanOrEqual(32);
  });

  it('could not be much taller: a line of text more and the buttons would leave the screen', () => {
    expect(() => assertCardFits({ compact: PHOTO_CARD_COMPACT, mediaHeightDp: PHOTO_BOX.height + BODY_LINE_DP })).toThrow();
  });

  it('leaves the words the rest of the card’s width, and no less', () => {
    expect(PHOTO_TEXT_WIDTH_DP).toBe(CARD_INNER_WIDTH_DP - PHOTO_BOX.width - MEDIA_GAP_DP);
    expect(PHOTO_TEXT_WIDTH_DP).toBeGreaterThanOrEqual(360);
  });

  it('has room beside the picture for the headline and for the notice that the mantelpiece is full', () => {
    const headline = linesOf(photoCardWords('Bartholomew').headline, charsPerLine);
    const notice = linesOf(MANTEL_FULL_NOTICE, charsPerLine);

    expect(headline).toBeLessThanOrEqual(2);
    expect(notice).toBeLessThanOrEqual(PHOTO_NOTICE_LINES);
    // The words are no taller than the picture, so the card is no taller for having them.
    expect((2 + PHOTO_NOTICE_LINES) * BODY_LINE_DP + layout.compactTextGapDp).toBeLessThanOrEqual(PHOTO_BOX.height);
    // And a notice a third longer — another language — still fits its lines.
    expect(linesOf(`${MANTEL_FULL_NOTICE} ${MANTEL_FULL_NOTICE.slice(0, Math.ceil(MANTEL_FULL_NOTICE.length * 0.3))}`, charsPerLine)).toBeLessThanOrEqual(PHOTO_NOTICE_LINES);
  });
});

describe('pictureAddress — a picture is fetched only from an https address', () => {
  it('takes an https address as it is', () => {
    expect(pictureAddress('https://pictures.example/photos/hh/p1.jpg?X-Amz-Signature=abc')).toBe('https://pictures.example/photos/hh/p1.jpg?X-Amz-Signature=abc');
  });

  it('takes nothing else: the card then says the picture cannot be shown, and its buttons still work', () => {
    for (const not of [undefined, '', 'http://pictures.example/p1.jpg', 'file:///data/p1.jpg', 'data:image/jpeg;base64,AAAA', 7, null]) {
      expect(pictureAddress(not)).toBeUndefined();
    }
  });
});

describe('PhotoCard.tsx — what a render cannot see', () => {
  // The card is drawn, its picture lost and its buttons pressed in CardRenderer.test.tsx. A check that passes
  // leaves nothing on the screen to see, so this one is still read as source.
  const view = readFileSync(fileURLToPath(new URL('../PhotoCard.tsx', import.meta.url)), 'utf8');

  it('checks its own height before anything reaches the screen', () => {
    expect(view).toMatch(/assertCardFits\(\{ compact: PHOTO_CARD_COMPACT, mediaHeightDp: PHOTO_BOX\.height \}\)/);
  });
});
