/**
 * The browser television draws every card as the Vega app draws it.
 *
 * The judge's point, taken as a test: the browser television (tv-core.js
 * renderCard, which tv.html and device.html both run) is a second renderer
 * of the cards, and nothing held it to the first. Here, for every card the
 * Vega app's render tests draw (apps/tv-vega/src/__tests__/render/cards.ts —
 * one or more of each kind the browser television knows, TV_CARD_TYPES),
 * the same card is drawn twice:
 *
 *   - by the Vega app's own CardRenderer, through React's reconciler, on the
 *     platform stand-in its render tests use (render/platform.ts);
 *   - by the browser television's renderCard, in the page the browser
 *     television's own tests run it in (tvPage.ts);
 *
 * and the two must show the same words in the same order, and the same
 * buttons — the same labels, in the same order, with the same one first and
 * amber. In English and in Spanish.
 *
 * The Vega app is the reference. Where the browser television draws
 * something on purpose that the Vega card does not, it is named below with
 * its reason (INTENDED), and nothing else may differ.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Card, HouseholdLanguage } from '@wick/contracts';
import { CalmPreferencesProvider, palette } from '@wick/vega-calm-ui';
import { CardRenderer } from '../../tv-vega/src/cards/CardRenderer.js';
import { KNOWN_CARD_TYPES } from '../../tv-vega/src/cards/knownCards.js';
import { CARD_CASES } from '../../tv-vega/src/__tests__/render/cards.js';
import { all, buttons as vegaButtons, flat, render, textOf } from '../../tv-vega/src/__tests__/render/render.js';
import { REMEMBERED, type El, tvPage } from './tvPage.js';

vi.mock('@amazon-devices/react-native-kepler', () => import('../../tv-vega/src/__tests__/render/platform.js'));

/** What a card shows: its words in order, and its buttons in order with the amber one marked. */
interface Shown {
  readonly words: readonly string[];
  readonly buttons: readonly string[];
}

const PRIMARY = ' [first, amber]';

/** A Text inside a button is the button's label, not one of the card's lines. */
function inside(node: { parent: unknown; type?: unknown }, type: string): boolean {
  for (let at = node.parent as { parent: unknown; type?: unknown } | null; at; at = at.parent as typeof at) if (at.type === type) return true;
  return false;
}

async function vegaShows(card: Card, language: HouseholdLanguage): Promise<Shown> {
  const drawn = await render(
    React.createElement(CalmPreferencesProvider, { preferences: { largerText: false, higherContrast: false } }, React.createElement(CardRenderer, { card, language, onAction: () => undefined })),
  );
  const root = drawn.root;
  const words = all(root, 'Text')
    .filter((text) => !inside(text, 'Text') && !inside(text, 'Pressable'))
    .map(textOf)
    .filter((line) => line.trim() !== '');
  const buttons = vegaButtons(root).map((b) => {
    const amber = flat(b.props.style).backgroundColor === palette.accent;
    return `${String(b.props.accessibilityLabel)}${amber ? PRIMARY : ''}`;
  });
  await drawn.unmount();
  return { words, buttons };
}

/** The browser television, paired and told her language, draws the card as tv-core.js renderCard draws it. */
function browserShows(card: Card, language: HouseholdLanguage, urgency: 'DOOR' | 'DEFERRED'): Shown {
  const tv = tvPage({ remembered: REMEMBERED });
  tv.open();
  tv.home({ language });
  const queued = { id: card.id, urgency, queuedAt: 1, shownCount: 0, card };
  tv.run(`renderCard(${JSON.stringify(queued)})`);
  const wrapper = tv.screen.children.find((child: El) => child.classList.contains('tv-card'))!;
  const nodes = wrapper.all();
  const words = nodes
    // The mark of the Play key is the television's own (read/ReadHint.tsx), drawn beside the card and not by CardRenderer.
    .filter((node) => !node.closest('.tv-read') && node.tagName !== 'button')
    .map((node) => node.ownText)
    .filter((line) => line.trim() !== '');
  const buttons = nodes
    .filter((node) => node.tagName === 'button')
    .map((b) => `${b.textContent}${b.classList.contains('primary') ? PRIMARY : ''}`);
  return { words, buttons };
}

/**
 * What the browser television draws on purpose and the Vega card does not, by card, with why. Each takes what
 * the browser drew and gives back what it must then equal on the Vega card; anything else must match as it is.
 */
const INTENDED: Record<string, (shown: Shown) => Shown> = {
  /*
   * The question about her language is one detail on the Vega card. The browser television draws the same words,
   * in the same order, as two paragraphs parted at the one space where the second language begins
   * (tv-core.js languageParagraphs), so that each carries its own `lang` for a screen reader — a web page can say
   * which language a paragraph is in, and a Vega Text cannot. Joined with that space, they are the Vega detail.
   */
  LANGUAGE: (shown) => ({ ...shown, words: [shown.words[0]!, shown.words.slice(1).join(' ')] }),
};

describe('parity — the browser television draws each card as the Vega app does', () => {
  it('knows the same kinds of card as the Vega app, and has a case here for each', () => {
    const tv = tvPage({ remembered: REMEMBERED });
    const browserKinds = tv.run('TV_CARD_TYPES') as string[];
    expect(new Set(browserKinds)).toEqual(new Set(KNOWN_CARD_TYPES));
    expect(new Set(CARD_CASES.map((c) => c.card.type))).toEqual(new Set(browserKinds));
  });

  describe.each(CARD_CASES)('$name', (example) => {
    it.each(['en', 'es'] as const)('in %s: the same words in the same order, and the same buttons', async (language) => {
      const card = language === 'es' ? example.spanish : example.card;
      const urgency = card.type === 'DOOR' ? 'DOOR' : 'DEFERRED';
      const vega = await vegaShows(card, language);
      const browser = browserShows(card, language, urgency);
      const allowed = INTENDED[example.name]?.(browser) ?? browser;
      expect(allowed).toEqual(vega);
    });
  });
});
