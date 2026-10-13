import { describe, expect, it } from 'vitest';
// The tokens alone: the package's index brings its components, and React Native with them.
import { layout as card, type as typeSizes } from '../../../../../packages/vega-calm-ui/src/tokens.js';
import { CARD_CLEARANCE_DP, rowsDrawn, waveDrawn } from '../layout.js';

/**
 * The family home screen as it is laid out (FamilyHome.tsx): 960x540dp,
 * 32dp above and below, 8dp between rows; the heading at 48pt, every other
 * row at 32pt. A card sits over the bottom of the screen.
 */
const SCREEN_DP = 540;
const EDGE_DP = 32;
const GAP_DP = 8;
const HEADING_DP = typeSizes.headlinePt * 1.25;
const LINE_DP = typeSizes.bodyPt * 1.4;

/** Where each row ends, top first: the heading, whose television it is, then the quiet rows. */
function rowBottoms(quietRows: number): number[] {
  const bottoms = [EDGE_DP + HEADING_DP];
  for (let i = 0; i < 1 + quietRows; i += 1) bottoms.push(bottoms[bottoms.length - 1]! + GAP_DP + LINE_DP);
  return bottoms;
}

/**
 * How tall a card is on the family home screen: CalmCard, compact
 * (packages/vega-calm-ui), from its own tokens. The television does not
 * work this out — it measures the card it has drawn. This is for saying
 * here how tall the server's cards come to.
 */
function cardHeight(c: { headlineLines: number; detailLines: number; buttonRows: number }): number {
  const text = c.headlineLines * LINE_DP + (c.detailLines > 0 ? card.compactTextGapDp + c.detailLines * LINE_DP : 0);
  const button = card.actionPaddingVerticalDp * 2 + typeSizes.bodyPt * 1.2 + 4;
  const buttons = c.buttonRows * button + (c.buttonRows - 1) * 16;
  return card.compactPaddingDp * 2 + text + card.compactGapDp + buttons;
}
const cardTop = (height: number): number => SCREEN_DP - EDGE_DP - height;

/** The tallest of each kind the server sends (mcp-server familyTvWatch.ts, familyTvWeek.ts, familyTelevision.ts). */
const CARDS = {
  // "Big Buck Bunny with Margaret, today at 3:00 pm." over two lines; "You can sit down now. Margaret’s television will say you are ready." over two; Sit down / Not now.
  film: cardHeight({ headlineLines: 2, detailLines: 2, buttonRows: 1 }),
  // "Margaret would like you to ring her." with its line of detail, and three answers that take two rows.
  ring: cardHeight({ headlineLines: 1, detailLines: 1, buttonRows: 2 }),
  // "Margaret’s week is ready to read." with its line of detail; Read it / Later.
  week: cardHeight({ headlineLines: 1, detailLines: 1, buttonRows: 1 }),
};

/** The four lines above a card on a demo home: the heading, whose television, that it is a demo, her light. */
const FOUR = rowBottoms(2);

const overlapped = (bottoms: readonly number[], drawn: readonly boolean[], top: number): number[] =>
  bottoms.map((bottom, i) => (drawn[i] && bottom + CARD_CLEARANCE_DP > top ? i : -1)).filter((i) => i >= 0);

describe('rowsDrawn — no line is ever drawn where a card covers it', () => {
  it('draws every row when no card is showing', () => {
    expect(rowsDrawn(FOUR, { showing: false })).toEqual([true, true, true, true]);
    expect(rowsDrawn([undefined, undefined, undefined], { showing: false })).toEqual([true, true, true]);
  });

  for (const [name, height] of Object.entries(CARDS)) {
    it(`leaves no drawn line under the tallest ${name} card, nor within reach of its rounded corner`, () => {
      const top = cardTop(height);
      const drawn = rowsDrawn(FOUR, { showing: true, top });

      expect(overlapped(FOUR, drawn, top)).toEqual([]);
      // Whose home, and whose television, are always said.
      expect(drawn.slice(0, 2)).toEqual([true, true]);
    });
  }

  it('draws all four lines above a week card: the week is the thing a demo home must say is simulated', () => {
    expect(rowsDrawn(FOUR, { showing: true, top: cardTop(CARDS.week) })).toEqual([true, true, true, true]);
  });

  it('draws a line whole or not at all: one the card would reach is left out, never cut', () => {
    const top = cardTop(CARDS.film);
    const drawn = rowsDrawn(FOUR, { showing: true, top });

    // The film card is the tallest: it leaves room for the heading and whose television it is, and for nothing under them.
    expect(drawn).toEqual([true, true, false, false]);
    expect(FOUR[2]! - LINE_DP).toBeLessThan(top);
    expect(FOUR[2]! + CARD_CLEARANCE_DP).toBeGreaterThan(top);
  });

  it('leaves out every row under one that is left out: a line is never drawn below a gap', () => {
    // The second row has not been measured yet; the one under it has, and would fit.
    expect(rowsDrawn([92, undefined, 197.6], { showing: true, top: 400 })).toEqual([true, false, false]);
    // And rows only ever end lower down the screen: past the first that does not fit, none does.
    expect(rowsDrawn([92, 144.8, 197.6, 250.4], { showing: true, top: 200 })).toEqual([true, true, false, false]);
  });

  it('keeps a line clear of the card by more than nothing: the card’s corner is round, and a line that touched it would show through', () => {
    expect(CARD_CLEARANCE_DP).toBeGreaterThanOrEqual(8);
    expect(rowsDrawn([100], { showing: true, top: 100 + CARD_CLEARANCE_DP })).toEqual([true]);
    expect(rowsDrawn([100], { showing: true, top: 100 + CARD_CLEARANCE_DP - 1 })).toEqual([false]);
  });

  it('holds for any card and any rows: whatever is drawn is clear of the card', () => {
    for (let height = 150; height <= 500; height += 7) {
      for (let quiet = 0; quiet <= 4; quiet += 1) {
        const bottoms = rowBottoms(quiet);
        const top = cardTop(height);
        expect(overlapped(bottoms, rowsDrawn(bottoms, { showing: true, top }), top)).toEqual([]);
      }
    }
  });

  it('before a new card has been measured, draws only whose home and whose television — never a line it cannot yet place', () => {
    expect(rowsDrawn(FOUR, { showing: true, top: undefined })).toEqual([true, true, false, false]);
  });

  it('does not draw, beside a measured card, a row it has not yet measured', () => {
    expect(rowsDrawn([92, 144.8, undefined], { showing: true, top: 400 })).toEqual([true, true, false]);
  });
});

describe('waveDrawn — the wave gives way to a card', () => {
  it('is drawn when no card is showing: under the lines, with nothing over it', () => {
    expect(waveDrawn('nothing')).toBe(true);
  });

  it('is not drawn at all while a card is showing — one with answers, one that only says how something stands, or the sentence after a press', () => {
    expect(waveDrawn('card')).toBe(false);
    expect(waveDrawn('said')).toBe(false);
  });
});
