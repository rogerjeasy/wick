/**
 * Every card the television draws, drawn — through the one renderer
 * (CardRenderer.tsx), as the app draws it, by React's own reconciler.
 *
 * Each kind of card, in the shapes that draw differently (the door before
 * and after its picture; the picture card with and without an address),
 * is drawn in each of the four ways Easier to see can leave the television
 * (seeing/seeing.ts: standard, larger text, higher contrast, both) and in
 * English and Spanish. What is checked is what the person in front of it
 * meets:
 *
 *   - it is drawn at all: no CalmViolation, nothing thrown;
 *   - three buttons at most, each one a labelled button, the first holding
 *     the focus, and a press sends back that button's id for that card;
 *   - one headline, announced as a header;
 *   - nothing under 32pt, and every word on its ground at 7:1 — 15:1 with
 *     higher contrast on;
 *   - with larger text on, a card is drawn larger as a whole or, where its
 *     words would not then be whole, at the standard size as a whole
 *     (vega-calm-ui theme.ts fitCard) — never half and half;
 *   - in Spanish, the Spanish words are on it.
 *
 * The platform is stood in for (src/__tests__/render/platform.ts); the
 * cards are the server's own (src/__tests__/render/cards.ts).
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Card, HouseholdLanguage } from '@wick/contracts';
import { CalmCard, CalmPreferencesProvider, CalmViolation, type CalmPreferences } from '@wick/vega-calm-ui';
import { CardRenderer } from '../CardRenderer.js';
import { KNOWN_CARD_TYPES } from '../knownCards.js';
import { LANGUAGE_CARD_COMPACT, LANGUAGE_DETAIL_LINES } from '../languageDetail.js';
import { PHOTO_CARD_COMPACT, PHOTO_NOTICE_LINES } from '../photoLayout.js';
import { CARD_CASES } from '../../__tests__/render/cards.js';
import { all, button, flat, named, buttons, contrastOf, fontSize, headers, preferred, press, render, settle, shows, textOf, texts } from '../../__tests__/render/render.js';

vi.mock('@amazon-devices/react-native-kepler', () => import('../../__tests__/render/platform.js'));

const SETTINGS: readonly (readonly [name: string, preferences: CalmPreferences])[] = [
  ['standard', { largerText: false, higherContrast: false }],
  ['larger text', { largerText: true, higherContrast: false }],
  ['higher contrast', { largerText: false, higherContrast: true }],
  ['larger text and higher contrast', { largerText: true, higherContrast: true }],
];
const LANGUAGES: readonly HouseholdLanguage[] = ['en', 'es'];

interface Drawing {
  readonly card: Card;
  readonly language: HouseholdLanguage;
  readonly preferences?: CalmPreferences;
  readonly onAction?: (cardId: string, actionId: string) => void;
  readonly onPictureFailed?: (cardId: string) => void;
}

/** A card as the app draws it: inside the theme her Easier to see settings make (seeing/SeeingProvider.tsx). */
function drawCard({ card, language, preferences = SETTINGS[0]![1], onAction = () => undefined, onPictureFailed }: Drawing) {
  return render(
    <CalmPreferencesProvider preferences={preferences}>
      <CardRenderer card={card} language={language} onAction={onAction} onPictureFailed={onPictureFailed} />
    </CalmPreferencesProvider>,
  );
}

/** Each line of words, at the size it is set. */
async function sizes(card: Card, language: HouseholdLanguage, preferences: CalmPreferences): Promise<number[]> {
  const drawn = await drawCard({ card, language, preferences });
  return all(drawn.root, 'Text').map(fontSize);
}

describe('the kinds of card', () => {
  it('has a case here for each kind the build knows: a kind added to the contract needs a card in render/cards.ts', () => {
    expect(new Set(CARD_CASES.map((c) => c.card.type))).toEqual(new Set(KNOWN_CARD_TYPES));
  });

  it('draws every kind the build knows (cards/knownCards.ts) — each below is drawn, with a headline and its buttons', async () => {
    for (const type of KNOWN_CARD_TYPES) {
      const example = CARD_CASES.find((c) => c.card.type === type)!;
      const drawn = await drawCard({ card: example.card, language: 'en' });
      expect({ type, headers: headers(drawn.root).length, buttons: buttons(drawn.root).length > 0 }).toEqual({ type, headers: 1, buttons: true });
    }
  });

  it('draws nothing at all for a kind it does not know — no card that takes the remote with nothing on it', async () => {
    const unknown = { ...byName('TELL').card, type: 'SOMETHING_NEW' } as unknown as Card;
    const drawn = await drawCard({ card: unknown, language: 'en' });
    expect(drawn.renderer.toJSON()).toBeNull();
  });
});

describe.each(CARD_CASES)('$name', (example) => {
  describe.each(SETTINGS)('%s', (_setting, preferences) => {
    it.each(LANGUAGES)('in %s: three buttons at most, labelled, one header, nothing under the floor, every word legible', async (language) => {
      const card = language === 'es' ? example.spanish : example.card;
      const drawn = await drawCard({ card, language, preferences });
      const root = drawn.root;

      // At most three, each a button with the words it shows as its label; the first holds the focus.
      const pressable = buttons(root);
      expect(pressable.length).toBeGreaterThanOrEqual(1);
      expect(pressable.length).toBeLessThanOrEqual(3);
      for (const b of pressable) {
        expect(b.props.accessibilityRole).toBe('button');
        expect(b.props.focusable).not.toBe(false);
        expect(typeof b.props.onPress).toBe('function');
        expect(b.props.accessibilityLabel).toBe(textOf(b));
        expect(String(b.props.accessibilityLabel).trim()).not.toBe('');
      }
      expect(preferred(root)).toEqual([named(pressable[0]!)]);

      // One headline, read out as a header.
      const [header, ...more] = headers(root);
      expect(more.length).toBe(0);
      expect(textOf(header!).trim()).not.toBe('');

      // Nothing under 32pt; every word against what it is written on at the theme's ratio.
      const floorRatio = preferences.higherContrast ? 15 : 7;
      for (const text of all(root, 'Text')) {
        expect(fontSize(text), textOf(text)).toBeGreaterThanOrEqual(32);
        expect(contrastOf(text), textOf(text)).toBeGreaterThanOrEqual(floorRatio);
      }

      // Larger text: larger as a whole, or — where its words would not be whole — the standard size as a whole.
      if (preferences.largerText) {
        const drawnSizes = all(root, 'Text').map(fontSize);
        const standard = await sizes(card, language, { ...preferences, largerText: false });
        if (!drawnSizes.every((size) => size >= 40)) expect(drawnSizes).toEqual(standard);
      }

      // Her language: the Spanish words are on the Spanish card, and not on the English one.
      if (example.card !== example.spanish) expect(shows(root, example.spanishWords)).toBe(language === 'es');
      else expect(shows(root, example.spanishWords)).toBe(true);
    });
  });

  it(`sends back "${example.press.id}" for this card when "${example.press.label}" is pressed`, async () => {
    const onAction = vi.fn();
    const drawn = await drawCard({ card: example.card, language: 'en', onAction });
    await press(button(drawn.root, example.press.label));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(example.card.id, example.press.id);
  });
});

const byName = (name: string): (typeof CARD_CASES)[number] => CARD_CASES.find((c) => c.name === name)!;

describe('larger text, where the words fit', () => {
  it.each(['WEEK', 'TELL', 'VISIT', 'WATCH'])('draws a short %s card at 40pt and up, in both languages', async (name) => {
    for (const language of LANGUAGES) {
      const example = byName(name);
      const drawn = await sizes(language === 'es' ? example.spanish : example.card, language, { largerText: true, higherContrast: false });
      expect(Math.min(...drawn), `${name} ${language}`).toBeGreaterThanOrEqual(40);
    }
  });
});

describe('the door card', () => {
  it('has no picture until one arrives, and keeps its room for one', async () => {
    const drawn = await drawCard({ card: byName('DOOR, before the picture').card, language: 'en' });
    expect(all(drawn.root, 'Image').length).toBe(0);
    // TwoPhaseCard reserves the frame's box at mount, so the picture patching in moves nothing.
    expect(all(drawn.root, 'View').filter((view) => flat(view.props.style).width === 256 && flat(view.props.style).height === 144).length).toBe(1);
  });

  it('shows the picture from the door, named for the screen reader in her language, and what the camera saw', async () => {
    const example = byName('DOOR, with picture and description');
    for (const [language, label] of [['en', 'Picture from the front door camera'], ['es', 'Imagen de la cámara de la puerta']] as const) {
      const drawn = await drawCard({ card: language === 'es' ? example.spanish : example.card, language });
      const [picture, ...others] = all(drawn.root, 'Image');
      expect(others.length).toBe(0);
      expect(picture!.props.source).toEqual({ uri: 'https://frames.example.com/door-evt-2.jpg' });
      expect(picture!.props.accessibilityLabel).toBe(label);
    }
    const drawn = await drawCard({ card: example.card, language: 'en' });
    expect(texts(drawn.root)).toContain('A woman in a blue coat holding a bag of shopping.');
  });

  it('says who it looks like until the camera has said who is there — and then the camera wins', async () => {
    const expected = byName('DOOR, expected visitor and a notice').card;
    const drawn = await drawCard({ card: expected, language: 'en' });
    expect(texts(drawn.root)).toContain('Maria is expected around now.');
    // The chime's answer is said where a screen reader hears it as it arrives.
    const notice = all(drawn.root, 'Text').find((t) => textOf(t) === 'The hallway chime rang.');
    expect(notice?.props.accessibilityLiveRegion).toBe('polite');

    await drawn.update(
      <CalmPreferencesProvider preferences={SETTINGS[0]![1]}>
        <CardRenderer card={{ ...expected, description: 'A woman at the door in a green coat.' } as Card} language="en" onAction={() => undefined} />
      </CalmPreferencesProvider>,
    );
    expect(shows(drawn.root, 'Maria is expected')).toBe(false);
    expect(texts(drawn.root)).toContain('A woman at the door in a green coat.');
  });
});

describe('a visitor the family arranged', () => {
  it('says the visitor is due, and under it who arranged a visit for about now — in her language, the visitor in the member’s words', async () => {
    const example = byName('DOOR, a visitor the family arranged');
    const english = await drawCard({ card: example.card, language: 'en' });
    expect(texts(english.root)).toContain('The plumber is expected around now.');
    expect(texts(english.root)).toContain('Sarah arranged a visit for about now.');

    const spanish = await drawCard({ card: example.spanish, language: 'es' });
    expect(texts(spanish.root)).toContain('Se espera a the plumber sobre esta hora.');
    expect(texts(spanish.root)).toContain('Sarah organizó una visita para esta hora.');
  });
});

describe('"Shall I tell Sarah?"', () => {
  it('starts on "Keep it to myself": silence is the default, and telling is one deliberate move away', async () => {
    const drawn = await drawCard({ card: byName('TELL').card, language: 'en' });

    expect(buttons(drawn.root).map((b) => b.props.accessibilityLabel)).toEqual(['Keep it to myself', 'Tell Sarah']);
    expect(preferred(drawn.root)).toEqual([named(buttons(drawn.root)[0]!)]);
  });
});

describe('the note from the family', () => {
  it('says who it is from in her language, shows the note, and offers her three replies', async () => {
    const example = byName('MESSAGE');
    const english = await drawCard({ card: example.card, language: 'en' });
    expect(headers(english.root).map(textOf)).toEqual(['A message from Sarah.']);
    expect(buttons(english.root).map((b) => b.props.accessibilityLabel)).toEqual(['Yes, please do.', 'Another day would be better.', 'No, thank you.']);

    const spanish = await drawCard({ card: example.spanish, language: 'es' });
    expect(headers(spanish.root).map(textOf)).toEqual(['Un mensaje de Sarah.']);
    expect(texts(spanish.root)).toContain('Pasaré el sábado con los nietos. ¿Llevo la comida?');
    expect(buttons(spanish.root).map((b) => b.props.accessibilityLabel)).toEqual(['Sí, por favor.', 'Mejor otro día.', 'No, gracias.']);
  });
});

describe('the picture from the family', () => {
  it('shows the picture whole, named for the screen reader', async () => {
    const drawn = await drawCard({ card: byName('PHOTO').card, language: 'es' });
    const [picture] = all(drawn.root, 'Image');
    expect(picture!.props.source).toEqual({ uri: 'https://pictures.example.com/ph_1.jpg' });
    expect(picture!.props.resizeMode).toBe('contain');
    expect(picture!.props.accessibilityLabel).toBe('Una foto de Sarah');
  });

  it('is drawn compact, with the server’s headline and two buttons as they came, and the notice given its five lines', async () => {
    const example = byName('PHOTO, mantelpiece full and no address');
    const drawn = await drawCard({ card: example.card, language: 'en' });
    const photo = example.card as Extract<Card, { type: 'PHOTO' }>;

    expect(drawn.root.findAllByType(CalmCard)[0]!.props.compact).toBe(PHOTO_CARD_COMPACT);
    expect(headers(drawn.root).map(textOf)).toEqual([photo.headline]);
    expect(buttons(drawn.root).map((b) => b.props.accessibilityLabel)).toEqual(photo.actions.map((a) => a.label));
    const notice = all(drawn.root, 'Text').find((t) => textOf(t) === photo.notice)!;
    expect(notice.props.numberOfLines).toBe(PHOTO_NOTICE_LINES);
    expect(notice.props.accessibilityLiveRegion).toBe('polite');
  });

  it('says calmly that a picture without an address cannot be shown, tells the app once, and its buttons still work', async () => {
    const example = byName('PHOTO, mantelpiece full and no address');
    const onPictureFailed = vi.fn();
    const onAction = vi.fn();
    const drawn = await drawCard({ card: example.card, language: 'en', onAction, onPictureFailed });

    expect(all(drawn.root, 'Image').length).toBe(0);
    expect(texts(drawn.root)).toContain('The picture cannot be shown just now.');
    expect(texts(drawn.root)).toContain('Your mantelpiece is full. Take one down, then you can keep this.');
    expect(onPictureFailed).toHaveBeenCalledTimes(1);
    expect(onPictureFailed).toHaveBeenCalledWith(example.card.id);

    await press(button(drawn.root, 'Keep it'));
    expect(onAction).toHaveBeenCalledWith(example.card.id, 'keep');
  });

  it('tells the app when an address that was good stops answering, and shows the calm line in the picture’s place', async () => {
    const onPictureFailed = vi.fn();
    const drawn = await drawCard({ card: byName('PHOTO').card, language: 'en', onPictureFailed });
    expect(onPictureFailed).not.toHaveBeenCalled();

    const [picture] = all(drawn.root, 'Image');
    await settle(() => picture!.props.onError());
    expect(onPictureFailed).toHaveBeenCalledWith('photo-ph_1');
    expect(all(drawn.root, 'Image').length).toBe(0);
    expect(texts(drawn.root)).toContain('The picture cannot be shown just now.');
  });
});

describe('the question about her language', () => {
  it('is drawn compact with six lines of detail, and the server’s words and two buttons exactly as they came', async () => {
    const example = byName('LANGUAGE');
    const drawn = await drawCard({ card: example.card, language: 'en' });
    const [card] = drawn.root.findAllByType(CalmCard);
    expect(card!.props.compact).toBe(LANGUAGE_CARD_COMPACT);
    expect(card!.props.detailLines).toBe(LANGUAGE_DETAIL_LINES);

    const question = example.card as Extract<Card, { type: 'LANGUAGE' }>;
    expect(headers(drawn.root).map(textOf)).toEqual([question.headline]);
    const detail = all(drawn.root, 'Text').find((t) => textOf(t) === question.detail)!;
    expect(detail.props.numberOfLines).toBe(6);
    expect(buttons(drawn.root).map((b) => b.props.accessibilityLabel)).toEqual(question.actions.map((a) => a.label));
  });
});

describe('what the calm floor refuses', () => {
  it('will not draw a fourth button: the card throws rather than reach the screen', async () => {
    const tell = byName('TELL').card;
    const four = { ...tell, actions: [...tell.actions, { id: 'a', label: 'A', kind: 'secondary' }, { id: 'b', label: 'B', kind: 'secondary' }] } as Card;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(drawCard({ card: four, language: 'en' })).rejects.toThrow(CalmViolation);
    } finally {
      quiet.mockRestore();
    }
  });
});
