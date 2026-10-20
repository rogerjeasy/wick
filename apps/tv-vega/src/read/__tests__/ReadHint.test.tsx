/**
 * The mark of the Play key on a card, drawn (read/ReadHint.tsx): the
 * speaker icon and "Read aloud" where the card's buttons leave room, the
 * icon alone where they do not — never a button, standing where
 * hintPlace.ts says, and saying its sentence to someone who cannot see it,
 * in her language.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CalmCard, CalmPreferencesProvider, calmTheme } from '@wick/vega-calm-ui';
import type { HouseholdLanguage } from '@wick/contracts';
import { KNOWN_CARD_TYPES } from '../../cards/knownCards.js';
import { ReadHint } from '../ReadHint.js';
import { COMPACT_CARDS, readChipFits, readChipHeightDp, readChipPlace } from '../hintPlace.js';
import { iconSizeDp } from '../../icons/icons.js';
import { CardRenderer } from '../../cards/CardRenderer.js';
import { CARD_CASES } from '../../__tests__/render/cards.js';
import { EASIER_TO_SEE, all, buttons, flat, render, texts } from '../../__tests__/render/render.js';

vi.mock('@amazon-devices/react-native-kepler', () => import('../../__tests__/render/platform.js'));
vi.mock('../../icons/iconSources.generated.js', () => import('../../__tests__/render/icons.js'));

async function hint(cardType: (typeof KNOWN_CARD_TYPES)[number], language: HouseholdLanguage = 'en', preferences = EASIER_TO_SEE[0]![1], actionLabels?: readonly string[]) {
  const drawn = await render(
    <CalmPreferencesProvider preferences={preferences}>
      <ReadHint cardType={cardType} language={language} actionLabels={actionLabels} />
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

  it('says "Read aloud" beside the speaker where the buttons leave room for it', async () => {
    const { root, mark } = await hint('LIGHT', 'en', EASIER_TO_SEE[0]![1], ['Put it out']);
    expect(texts(root)).toEqual(['Read aloud']);
    expect(all(root, 'Image')[0]?.props.source).toEqual({ uri: 'icon:read-ink-32' });
    expect(flat(mark.props.style).backgroundColor).toBe(calmTheme().palette.raisedHigh);
  });

  it('is the speaker alone where the buttons fill their row — no words to lie over a button', async () => {
    const replies = ['Lovely, see you then', 'Not this week', 'Ring me first'];
    expect(readChipFits(calmTheme(), 'MESSAGE', replies, 'Read aloud')).toBe(false);
    const { root } = await hint('MESSAGE', 'en', EASIER_TO_SEE[0]![1], replies);
    expect(texts(root)).toEqual([]);
    expect(all(root, 'Image')).toHaveLength(1);
  });

  it('is not a button: nothing to focus or press, and taps pass through it — a card’s three buttons stay three', async () => {
    const { root, mark } = await hint('DOOR');
    expect(buttons(root).length).toBe(0);
    expect(mark.props.pointerEvents).toBe('none');
    expect(mark.props.focusable).toBeUndefined();
    expect(mark.props.onPress).toBeUndefined();
  });

  it.each(EASIER_TO_SEE)('stands a chip where hintPlace says, centred on the buttons, with %s', async (_name, preferences) => {
    const { mark } = await hint('LIGHT', 'en', preferences, ['OK']);
    const place = readChipPlace('LIGHT', calmTheme(preferences), readChipHeightDp(calmTheme(preferences)));
    expect({ right: flat(mark.props.style).right, bottom: flat(mark.props.style).bottom }).toEqual(place);
  });

  it.each(EASIER_TO_SEE)('stands where hintPlace says on every kind of card, with %s', async (_name, preferences) => {
    for (const type of KNOWN_CARD_TYPES) {
      const { mark } = await hint(type, 'en', preferences);
      const at = flat(mark.props.style);
      const place = readChipPlace(type, calmTheme(preferences), iconSizeDp(calmTheme(preferences)));
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
