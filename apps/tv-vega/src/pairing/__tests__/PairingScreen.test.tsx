/**
 * The pairing screen, drawn (pairing/PairingScreen.tsx): a code, where to
 * enter it, and nothing else — in English, whatever language a home later
 * chooses, because there is no home yet to have one.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CalmPreferencesProvider, calmTheme, type CalmPreferences } from '@wick/vega-calm-ui';
import { PairingScreen, type PairingScreenProps } from '../PairingScreen.js';
import { STILL_TRYING } from '../connect.js';
import { EASIER_TO_SEE, all, buttons, fontSize, illegible, render, texts } from '../../__tests__/render/render.js';

vi.mock('@amazon-devices/react-native-kepler', () => import('../../__tests__/render/platform.js'));

const INFO = { code: '482913', url: 'https://wick.example.com/pair?code=482913', expiresAt: 1_800_000_600_000 };

async function pairing(props: PairingScreenProps, preferences: CalmPreferences = EASIER_TO_SEE[0]![1]) {
  return render(
    <CalmPreferencesProvider preferences={preferences}>
      <PairingScreen {...props} />
    </CalmPreferencesProvider>,
  );
}

describe('PairingScreen', () => {
  it('shows the code, large, where to enter it, and the address — and nothing to press', async () => {
    const { root } = await pairing({ info: INFO });

    expect(texts(root)).toEqual(['Set up Wick', '482913', 'Enter this code in the Wick family app. There you say whose television this is.', INFO.url]);
    const code = all(root, 'Text').find((t) => t.children.join('') === '482913')!;
    expect(fontSize(code)).toBe(calmTheme().fontSize('display'));
    expect(buttons(root).length).toBe(0);
  });

  it('says it is getting a code before there is one, and promises nothing more', async () => {
    const { root } = await pairing({});
    expect(texts(root)).toEqual(['Set up Wick', 'Getting a code…']);
  });

  it('says so under it while the pairing service cannot be reached, in the family screen’s own words', async () => {
    const { root } = await pairing({ trying: true });
    expect(texts(root)).toEqual(['Set up Wick', 'Getting a code…', STILL_TRYING]);
    expect(STILL_TRYING).toBe('Wick cannot reach the home just now.');
  });

  it.each(EASIER_TO_SEE)('is legible with %s', async (_name, preferences) => {
    const { root } = await pairing({ info: INFO, trying: true }, preferences);
    expect(illegible(root, preferences)).toEqual([]);
  });
});
