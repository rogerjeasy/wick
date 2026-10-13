/**
 * The mark of the Play key on a card (read/ReadHint.tsx) — where it stands,
 * and why it is a mark and not a sentence (packages/contracts speech.ts:
 * "said on the card in one short line").
 *
 * A line of 32pt does not fit on a card that is already at its limit, and
 * three kinds are: the ordinary card with five lines of detail, the
 * question about her language with six, and the picture card. The numbers
 * are below. So the sentence is what the screen reader says, and what is
 * drawn is the key's own mark, at the right-hand end of the buttons' row —
 * small enough that it can never lie over a button's words.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Card } from '@wick/contracts';
import { cardHeightDp } from '../../../../../packages/vega-calm-ui/src/constraints.js';
import { layout, type } from '../../../../../packages/vega-calm-ui/src/tokens.js';
import { KNOWN_CARD_TYPES } from '../../cards/knownCards.js';
import { LANGUAGE_DETAIL_LINES } from '../../cards/languageDetail.js';
import { PHOTO_BOX } from '../../cards/photoLayout.js';
import { COMPACT_CARDS, HINT_MARK, hintPlace } from '../hintPlace.js';

const ROOM_DP = layout.screenHeightDp - 2 * layout.screenMarginDp;
const LINE_DP = type.bodyPt * layout.lineHeight.body;
const BUTTON_ROW_DP = layout.actionPaddingVerticalDp * 2 + LINE_DP;
/** A button's own padding and border between the end of its words and its edge (CalmCard `action`). */
const BUTTON_INSET_DP = 32 + 2;

describe('why not a sentence — a card at its limit has no line to spare at 32pt', () => {
  it('the ordinary card with five lines of detail', () => {
    expect(cardHeightDp({}) + layout.textGapDp + LINE_DP).toBeGreaterThan(ROOM_DP);
  });

  it('the question about her language, with six', () => {
    expect(cardHeightDp({ compact: true, detailLines: LANGUAGE_DETAIL_LINES }) + layout.compactTextGapDp + LINE_DP).toBeGreaterThan(ROOM_DP);
  });

  it('the picture card: its picture is as tall as the card allows, and under the buttons is the screen’s margin', () => {
    expect(cardHeightDp({ compact: true, mediaHeightDp: PHOTO_BOX.height }) + LINE_DP).toBeGreaterThan(ROOM_DP);
  });

  it('nor is there a line’s height above the tallest cards, or under any: the margins are less than one line', () => {
    expect(layout.screenMarginDp).toBeLessThan(LINE_DP);
    expect(layout.screenHeightDp - layout.screenMarginDp - cardHeightDp({}) - layout.screenMarginDp).toBeLessThan(LINE_DP);
  });
});

describe('hintPlace — where the mark stands, on every kind of card', () => {
  it('is in the buttons’ row, at its right-hand end, inside the card’s own padding', () => {
    for (const cardType of KNOWN_CARD_TYPES) {
      const compact = COMPACT_CARDS.includes(cardType);
      const padding = compact ? layout.compactPaddingDp : layout.cardPaddingDp;
      const place = hintPlace(cardType);

      // The card layer keeps a card 48dp from the side and 32 from the bottom (ResidentApp `cardLayer`, DoorCard `lowerThird`).
      expect(place.right, cardType).toBe(48 + padding);
      // Centred on the one row of buttons every card ends with.
      expect(place.bottom, cardType).toBeCloseTo(32 + padding + (BUTTON_ROW_DP - HINT_MARK.height) / 2, 5);
    }
  });

  it('is small enough never to lie over a button’s words: no wider than the button’s own padding', () => {
    expect(HINT_MARK.width).toBeLessThanOrEqual(BUTTON_INSET_DP);
    expect(HINT_MARK.height).toBeLessThanOrEqual(BUTTON_ROW_DP);
  });

  it('is not small: about as tall as the words on the card', () => {
    expect(HINT_MARK.height).toBeGreaterThanOrEqual(type.bodyPt - 4);
  });

  it('knows which cards are drawn compact — the ones whose views say so, and no others', () => {
    const cards = fileURLToPath(new URL('../../cards/', import.meta.url));
    const views = readdirSync(cards).filter((file) => /Card\.tsx$/.test(file));
    const compact = views
      .filter((file) => /<(CalmCard|TwoPhaseCard)\b[^>]*?\bcompact\b/s.test(readFileSync(`${cards}${file}`, 'utf8')))
      .map((file) => file.replace(/Card\.tsx$/, '').toUpperCase())
      .sort();

    expect(views.length).toBe(KNOWN_CARD_TYPES.length);
    expect(compact).toEqual([...COMPACT_CARDS].sort());
  });

  it('has a place for a card of a kind it has not heard of, as an ordinary card', () => {
    expect(hintPlace('SOMETHING_NEW' as Card['type'])).toEqual(hintPlace('WEEK'));
  });
});

describe('ReadHint.tsx — the mark, as drawn', () => {
  const view = readFileSync(fileURLToPath(new URL('../ReadHint.tsx', import.meta.url)), 'utf8');

  it('says the sentence to someone who cannot see it, in her language', () => {
    expect(view).toMatch(/accessibilityLabel=\{words\(language\)\('read\.hint'\)\}/);
  });

  it('is drawn, not written: a shape that needs no letter of any font', () => {
    expect(view).not.toMatch(/<Text\b/);
    expect(view).toMatch(/borderLeftWidth: HINT_MARK\.width/);
  });

  it('is not a button: it cannot be focused or pressed, and the card’s three stay three', () => {
    expect(view).not.toMatch(/Pressable|onPress|focusable(?!=\{false\})/);
    expect(view).toMatch(/pointerEvents="none"/);
  });

  it('stands where hintPlace says', () => {
    expect(view).toMatch(/const place = hintPlace\(cardType\);/);
    expect(view).toMatch(/right: place\.right, bottom: place\.bottom/);
  });
});
