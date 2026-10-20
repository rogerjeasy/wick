/**
 * How Wick works, drawn (tour/TourScreen.tsx): each step's example as the
 * real thing is drawn, marked "Example", why under it, and the buttons —
 * every word at the floor, in every Easier to see setting.
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CalmPreferencesProvider, type CalmPreferences } from '@wick/vega-calm-ui';
import { EASIER_TO_SEE, all, buttons, illegible, press, render, texts } from '../../__tests__/render/render.js';
import { resetPlatform } from '../../__tests__/render/platform.js';
import { TOUR_STEPS } from '../tour.js';
import { TourScreen } from '../TourScreen.js';

vi.mock('@amazon-devices/react-native-kepler', () => import('../../__tests__/render/platform.js'));
vi.mock('../../icons/iconSources.generated.js', () => import('../../__tests__/render/icons.js'));
vi.mock('../tourPicture.js', () => ({ TOUR_DOOR_PICTURE: { uri: 'tour:door' } }));

const STANDARD: CalmPreferences = { largerText: false, higherContrast: false };

const step = (index: number, onAction = vi.fn(), preferences = STANDARD, language: 'en' | 'es' = 'en'): React.JSX.Element => (
  <CalmPreferencesProvider preferences={preferences}>
    <TourScreen index={index} language={language} onAction={onAction} />
  </CalmPreferencesProvider>
);

beforeEach(() => resetPlatform());

describe('How Wick works', () => {
  it('shows the door first, as the door card draws it, with the sample picture, marked Example', async () => {
    const { root } = await render(step(0));
    expect(texts(root)).toEqual([
      "Someone's at the front door.",
      'A person with a parcel is at the door.',
      'How Wick works · 1 of 5',
      'Example',
      'When the doorbell rings, this comes over anything, even another app. One button asks your family to look.',
      'Show me the next',
      'Close the tour',
    ]);
    expect(all(root, 'Image')[0]?.props.source).toEqual({ uri: 'tour:door' });
  });

  it('says a note, the hold line and the read mark, each as it is drawn', async () => {
    expect(texts((await render(step(1))).root)).toEqual(expect.arrayContaining(['A note from your family', "Hello! I'll ring you at seven.", 'Example']));
    const hold = (await render(step(2))).root;
    expect(texts(hold)).toEqual(expect.arrayContaining(['Keep holding to ask your family to ring you', 'Hold OK for two seconds', 'Example']));
    expect(all(hold, 'Image')[0]?.props.source).toEqual({ uri: 'icon:hold-ink-32' });
    const read = (await render(step(3))).root;
    expect(texts(read)).toEqual(expect.arrayContaining(['Read aloud', 'Press Play to hear any card']));
    expect(all(read, 'Image')[0]?.props.source).toEqual({ uri: 'icon:read-ink-32' });
  });

  it('ends with one button back to the films, and no example', async () => {
    const { root } = await render(step(TOUR_STEPS.length - 1));
    expect(texts(root)).not.toContain('Example');
    expect(buttons(root).map((b) => b.props.accessibilityLabel)).toEqual(['Back to the films']);
  });

  it('hands the press to the app: next, or close', async () => {
    const onAction = vi.fn();
    const { root } = await render(step(0, onAction));
    const [next, close] = buttons(root);
    expect(next!.props.hasTVPreferredFocus).toBe(true);
    await press(next!);
    await press(close!);
    expect(onAction.mock.calls).toEqual([['next'], ['close']]);
  });

  it('speaks her language', async () => {
    const { root } = await render(step(0, vi.fn(), STANDARD, 'es'));
    expect(texts(root)).toEqual(expect.arrayContaining(['Hay alguien en la puerta.', 'Ejemplo', 'Ver el siguiente']));
  });

  for (const [name, preferences] of EASIER_TO_SEE) {
    it(`is legible at every step with ${name}`, async () => {
      for (let i = 0; i < TOUR_STEPS.length; i += 1) {
        const { root } = await render(step(i, vi.fn(), preferences));
        // A step with no room at 40pt is drawn at 32pt, as a card is: still the floor, still the contrast she chose.
        expect(illegible(root, { ...preferences, largerText: false }), `step ${i}`).toEqual([]);
      }
    });
  }
});
