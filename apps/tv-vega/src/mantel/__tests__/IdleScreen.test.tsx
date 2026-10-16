/**
 * The idle screen, drawn (mantel/IdleScreen.tsx): her pictures, one at a
 * time, filling a home screen that has sat untouched — no words but who
 * the picture is from, no controls, a 200 ms fade, and the remote's focus
 * held for as long as it is mounted so the key that ends it reaches
 * nothing underneath.
 */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalmPreferencesProvider, motion } from '@wick/vega-calm-ui';
import type { HouseholdLanguage, MantelItem } from '@wick/contracts';
import { IdleScreen } from '../IdleScreen.js';
import * as platform from '../../__tests__/render/platform.js';
import { EASIER_TO_SEE, all, buttons, illegible, preferred, render, settle, texts } from '../../__tests__/render/render.js';

vi.mock('@amazon-devices/react-native-kepler', () => import('../../__tests__/render/platform.js'));

const SARAH: MantelItem = { photoId: 'ph_1', fromName: 'Sarah', keptAt: 1, url: 'https://pictures.example.com/ph_1.jpg' };
const TOM: MantelItem = { photoId: 'ph_2', fromName: 'Tom', keptAt: 2, url: 'https://pictures.example.com/ph_2.jpg' };

afterEach(() => {
  platform.resetPlatform();
  vi.restoreAllMocks();
});

function idle(props: { visible: boolean; item: MantelItem | undefined; language?: HouseholdLanguage; onFailed?: (id: string) => void }, preferences = EASIER_TO_SEE[0]![1]) {
  return (
    <CalmPreferencesProvider preferences={preferences}>
      <IdleScreen language={props.language ?? 'en'} visible={props.visible} item={props.item} onFailed={props.onFailed ?? (() => undefined)} />
    </CalmPreferencesProvider>
  );
}

describe('IdleScreen', () => {
  it('shows the picture whole, and under it only who it is from — in her language', async () => {
    const { root } = await render(idle({ visible: true, item: SARAH, language: 'es' }));

    const [picture, ...others] = all(root, 'Image');
    expect(others.length).toBe(0);
    expect(picture!.props.source).toEqual({ uri: SARAH.url });
    expect(picture!.props.resizeMode).toBe('contain');
    expect(texts(root)).toEqual(['De Sarah']);
  });

  it('holds the remote’s focus, with nothing on it to press or hold', async () => {
    const { root } = await render(idle({ visible: true, item: SARAH }));

    const [holder, ...more] = buttons(root);
    expect(more.length).toBe(0);
    expect(holder!.props.focusable).toBe(true);
    expect(preferred(root)).toEqual(['A picture from Sarah']);
    expect(holder!.props.onPress).toBeUndefined();
    expect(holder!.props.onLongPress).toBeUndefined();
  });

  it('draws nothing once a key has ended it, and still holds the focus until that key has come up', async () => {
    const { root } = await render(idle({ visible: false, item: SARAH }));

    expect(all(root, 'Image').length).toBe(0);
    expect(all(root, 'Text').length).toBe(0);
    expect(buttons(root).length).toBe(1);
    expect(buttons(root)[0]!.props.hasTVPreferredFocus).toBe(true);
  });

  it('says nothing in the picture’s place when it cannot be shown, and tells the app which picture it was', async () => {
    const onFailed = vi.fn();
    const { root } = await render(idle({ visible: true, item: SARAH, onFailed }));

    await settle(() => all(root, 'Image')[0]!.props.onError());
    expect(onFailed).toHaveBeenCalledWith('ph_1');
    expect(all(root, 'Image').length).toBe(0);
    expect(texts(root)).toEqual(['From Sarah']);
  });

  it('brings each picture up over the motion token’s 200 ms, and nothing else moves', async () => {
    const timing = vi.spyOn(platform.Animated, 'timing');
    const drawn = await render(idle({ visible: true, item: SARAH }));
    await drawn.update(idle({ visible: true, item: TOM }));

    expect(timing.mock.calls.map(([, config]) => config.duration)).toEqual([motion.durationMs, motion.durationMs]);
    expect(motion.durationMs).toBe(200);
  });

  it('has no timer of its own: ten minutes on, the same picture is up and nothing else has been asked for', async () => {
    vi.useFakeTimers();
    try {
      const timing = vi.spyOn(platform.Animated, 'timing');
      const onFailed = vi.fn();
      const { root } = await render(idle({ visible: true, item: SARAH, onFailed }));
      expect(vi.getTimerCount()).toBe(0);
      await settle(() => {
        vi.advanceTimersByTime(10 * 60 * 1000);
      });

      expect(all(root, 'Image')[0]!.props.source).toEqual({ uri: SARAH.url });
      expect(timing).toHaveBeenCalledTimes(1);
      expect(onFailed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('listens for no key and takes no Back: the app hears every key, in one place', async () => {
    await render(idle({ visible: true, item: SARAH }));
    expect(platform.pressBack()).toBe(false);
  });

  it.each(EASIER_TO_SEE)('writes who it is from legibly, with %s', async (_name, preferences) => {
    const { root } = await render(idle({ visible: true, item: SARAH }, preferences));
    expect(illegible(root, preferences)).toEqual([]);
  });
});
