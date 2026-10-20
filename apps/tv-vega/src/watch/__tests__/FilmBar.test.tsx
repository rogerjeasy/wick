/**
 * The film's bar, drawn (watch/FilmBar.tsx) — by React's own reconciler
 * over the platform stood in for in src/__tests__/render. When it shows is
 * transport.ts's, tested there; this is what it says, and that every word
 * of it is at the floor in each Easier to see setting.
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CalmPreferencesProvider, type CalmPreferences } from '@wick/vega-calm-ui';
import { EASIER_TO_SEE, all, flat, illegible, render, texts } from '../../__tests__/render/render.js';
import { resetPlatform, timings } from '../../__tests__/render/platform.js';
import { FilmBar, type FilmBarProps } from '../FilmBar.js';

vi.mock('@amazon-devices/react-native-kepler', () => import('../../__tests__/render/platform.js'));
vi.mock('../../icons/iconSources.generated.js', () => import('../../__tests__/render/icons.js'));

const STANDARD: CalmPreferences = { largerText: false, higherContrast: false };

function bar(props: Partial<FilmBarProps> = {}, preferences: CalmPreferences = STANDARD): React.JSX.Element {
  const all: FilmBarProps = { shown: true, language: 'en', title: 'Sintel', positionMs: 245_000, durationMs: 888_000, paused: false, ...props };
  return (
    <CalmPreferencesProvider preferences={preferences}>
      <FilmBar {...all} />
    </CalmPreferencesProvider>
  );
}

beforeEach(() => resetPlatform());

describe('the film’s bar', () => {
  it('says the title, the time gone of the whole, and how long is left', async () => {
    const drawn = await render(bar());
    expect(texts(drawn.root)).toEqual(['Sintel', '11 min left', '4:05 of 14:48']);
  });

  it('draws the progress line as far as the film has got', async () => {
    const drawn = await render(bar());
    const fill = all(drawn.root, 'Animated.View').map((node) => flat(node.props.style)).find((style) => typeof style.width === 'string');
    expect(fill?.width).toBe('27.6%');
  });

  it('is one sentence to the screen reader, and is never pressed', async () => {
    const drawn = await render(bar({ paused: true }));
    const read = all(drawn.root, 'View').find((node) => node.props.accessible === true);
    expect(read?.props.accessibilityLabel).toBe('Paused — Sintel. 4:05 of 14:48. 11 min left.');
    expect(all(drawn.root, 'Pressable')).toEqual([]);
    const playing = await render(bar({ companion: 'Sarah' }));
    expect(all(playing.root, 'View').find((node) => node.props.accessible === true)?.props.accessibilityLabel).toBe('Sintel. 4:05 of 14:48. 11 minutes left. Sarah is watching with you.');
  });

  it('shows the pause mark and the film’s licence while it is paused, and the play mark while it plays', async () => {
    const paused = await render(bar({ paused: true, attribution: '© Blender Foundation | durian.blender.org' }));
    expect(all(paused.root, 'Image')[0]?.props.source).toEqual({ uri: 'icon:pause-ink-32' });
    expect(texts(paused.root)).toContain('© Blender Foundation | durian.blender.org');
    const playing = await render(bar({ attribution: '© Blender Foundation | durian.blender.org' }));
    expect(all(playing.root, 'Image')[0]?.props.source).toEqual({ uri: 'icon:play-ink-32' });
    expect(texts(playing.root)).not.toContain('© Blender Foundation | durian.blender.org');
  });

  it('says who is watching along', async () => {
    const drawn = await render(bar({ companion: 'Sarah' }));
    expect(texts(drawn.root)).toContain('Sarah is watching with you.');
  });

  it('speaks her language', async () => {
    const drawn = await render(bar({ language: 'es' }));
    expect(texts(drawn.root)).toEqual(['Sintel', 'Faltan 11 min', '4:05 de 14:48']);
  });

  it('fades in, in 200ms — and is drawn no more once it has faded out', async () => {
    const drawn = await render(bar());
    expect(timings).toContainEqual({ toValue: 1, duration: 200 });
    await drawn.update(bar({ shown: false }));
    expect(timings).toContainEqual({ toValue: 0, duration: 150 });
    expect(texts(drawn.root)).toEqual([]);
  });

  for (const [name, preferences] of EASIER_TO_SEE) {
    it(`is legible with ${name}`, async () => {
      const drawn = await render(bar({ paused: true, companion: 'Sarah', attribution: '© Blender Foundation' }, preferences));
      expect(illegible(drawn.root, preferences)).toEqual([]);
    });
  }
});
