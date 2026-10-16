/**
 * The mark of the Play key on a card, drawn (read/ReadHint.tsx): a shape,
 * not a word and not a button, standing where hintPlace.ts says, and
 * saying its sentence to someone who cannot see it, in her language.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CalmCard, CalmPreferencesProvider, calmTheme } from '@wick/vega-calm-ui';
import type { HouseholdLanguage } from '@wick/contracts';
import { KNOWN_CARD_TYPES } from '../../cards/knownCards.js';
import { ReadHint } from '../ReadHint.js';
import { COMPACT_CARDS, HINT_MARK, hintPlace } from '../hintPlace.js';
import { CardRenderer } from '../../cards/CardRenderer.js';
import { CARD_CASES } from '../../__tests__/render/cards.js';
import { EASIER_TO_SEE, all, buttons, flat, render } from '../../__tests__/render/render.js';

vi.mock('@amazon-devices/react-native-kepler', () => import('../../__tests__/render/platform.js'));

async function hint(cardType: (typeof KNOWN_CARD_TYPES)[number], language: HouseholdLanguage = 'en', preferences = EASIER_TO_SEE[0]![1]) {
  const drawn = await render(
    <CalmPreferencesProvider preferences={preferences}>
      <ReadHint cardType={cardType} language={language} />
    </CalmPreferencesProvider>,
  );
  return { root: drawn.root, mark: all(drawn.root, 'View')[0]! };
}

describe('ReadHint', () => {
  it('says the sentence to someone who cannot see it, in her language', async () => {
    expect((await hint('MESSAGE', 'en')).mark.props.accessibilityLabel).toBe('Press Play to hear this.');
    expect((await hint('MESSAGE', 'es')).mark.props.accessibilityLabel).toBe('Presione Play para oír esto.');
    const { mark } = await hint('MESSAGE');
    expect(mark.props.accessible).toBe(true);
    expect(mark.props.accessibilityRole).toBe('image');
  });

  it('is drawn, not written: no words at all, a triangle made of borders in the ink colour', async () => {
    const { root } = await hint('WEEK');
    expect(all(root, 'Text').length).toBe(0);
    const shape = flat(all(root, 'View')[1]!.props.style);
    expect(shape).toMatchObject({ width: 0, height: 0, borderLeftWidth: HINT_MARK.width, borderTopColor: 'transparent', borderBottomColor: 'transparent' });
    expect(shape.borderLeftColor).toBe(calmTheme().palette.ink);
  });

  it('is not a button: nothing to focus or press, and taps pass through it — a card’s three buttons stay three', async () => {
    const { root, mark } = await hint('DOOR');
    expect(buttons(root).length).toBe(0);
    expect(mark.props.pointerEvents).toBe('none');
    expect(mark.props.focusable).toBeUndefined();
    expect(mark.props.onPress).toBeUndefined();
  });

  it.each(EASIER_TO_SEE)('stands where hintPlace says on every kind of card, with %s', async (_name, preferences) => {
    for (const type of KNOWN_CARD_TYPES) {
      const { mark } = await hint(type, 'en', preferences);
      const at = flat(mark.props.style);
      const place = hintPlace(type, calmTheme(preferences));
      expect({ type, right: at.right, bottom: at.bottom, position: at.position }).toEqual({ type, right: place.right, bottom: place.bottom, position: 'absolute' });
    }
  });

  it('knows which cards are drawn compact: the ones whose drawn CalmCard is, and no others', async () => {
    const compact = new Set<string>();
    for (const example of CARD_CASES) {
      const drawn = await render(<CardRenderer card={example.card} language="en" onAction={() => undefined} />);
      const [card] = drawn.root.findAllByType(CalmCard);
      if (card!.props.compact === true) compact.add(example.card.type);
    }
    expect([...compact].sort()).toEqual([...COMPACT_CARDS].sort());
  });
});
