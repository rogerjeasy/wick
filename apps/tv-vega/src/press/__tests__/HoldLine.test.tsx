/**
 * The hold line, drawn (press/HoldLine.tsx): nothing for an ordinary
 * press, then from 0.4 s a bar that says what holding will do, with a line
 * that fills to the two seconds; let go, and it is gone.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalmPreferencesProvider } from '@wick/vega-calm-ui';
import { EASIER_TO_SEE, illegible, render, settle, texts } from '../../__tests__/render/render.js';
import { resetPlatform, timings } from '../../__tests__/render/platform.js';
import { HoldLine, holdLineWords } from '../HoldLine.js';

vi.mock('@amazon-devices/react-native-kepler', () => import('../../__tests__/render/platform.js'));
vi.mock('../../icons/iconSources.generated.js', () => import('../../__tests__/render/icons.js'));

const T = 1_800_000_000_000;

beforeEach(() => {
  resetPlatform();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(T);
});
afterEach(() => vi.useRealTimers());

const line = (since: number | null, name?: string, preferences = { largerText: false, higherContrast: false }): React.JSX.Element => (
  <CalmPreferencesProvider preferences={preferences}>
    <HoldLine since={since} language="en" name={name} />
  </CalmPreferencesProvider>
);

describe('the hold line', () => {
  it('names the person holding would ask, or says what it does without a name', () => {
    expect(holdLineWords('en', 'Sarah')).toBe('Keep holding to ask Sarah to ring you');
    expect(holdLineWords('en', undefined)).toBe('Keep holding to ask for a call');
    expect(holdLineWords('es', undefined)).toBe('Siga pulsando para pedir una llamada');
  });

  it('shows nothing for an ordinary press, then the words from 0.4 s, filling evenly to the two seconds', async () => {
    const drawn = await render(line(T));
    expect(texts(drawn.root)).toEqual([]);
    await settle(() => void vi.advanceTimersByTime(399));
    expect(texts(drawn.root)).toEqual([]);
    await settle(() => void vi.advanceTimersByTime(1));
    expect(texts(drawn.root)).toEqual(['Keep holding to ask for a call']);
    // The fill: the rest of the two seconds, from where the hold has got.
    expect(timings).toContainEqual({ toValue: 1, duration: 1600 });
  });

  it('goes the moment OK is let go', async () => {
    const drawn = await render(line(T, 'Sarah'));
    await settle(() => void vi.advanceTimersByTime(800));
    expect(texts(drawn.root)).toEqual(['Keep holding to ask Sarah to ring you']);
    await drawn.update(line(null, 'Sarah'));
    expect(texts(drawn.root)).toEqual([]);
  });

  it('never shows for a press let go before 0.4 s', async () => {
    const drawn = await render(line(T));
    await settle(() => void vi.advanceTimersByTime(200));
    await drawn.update(line(null));
    await settle(() => void vi.advanceTimersByTime(2000));
    expect(texts(drawn.root)).toEqual([]);
  });

  for (const [name, preferences] of EASIER_TO_SEE) {
    it(`is legible with ${name}`, async () => {
      const drawn = await render(line(T, 'Sarah', preferences));
      await settle(() => void vi.advanceTimersByTime(500));
      expect(illegible(drawn.root, preferences)).toEqual([]);
    });
  }
});
