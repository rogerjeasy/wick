/**
 * Easier to see, drawn: the card (seeing/SeeingCard.tsx) inside the one
 * provider at the root of the app (seeing/SeeingProvider.tsx), with a
 * press handed back to it the way ResidentApp.tsx hands it.
 *
 * What is checked is what she sees happen: three buttons, each saying how
 * its setting stands; a press changes the whole screen at once, the card
 * included; her choice is written to the television's disk and read back
 * at the next launch, before anything is drawn; and the platform's own
 * high-contrast setting is the default until she says otherwise.
 */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HouseholdLanguage } from '@wick/contracts';
import { calmTheme } from '@wick/vega-calm-ui';
import { SeeingCard } from '../SeeingCard.js';
import { SeeingProvider, useSeeing } from '../SeeingProvider.js';
import { SEEING_PATH } from '../seeingStore.js';
import { accessibility, resetPlatform } from '../../__tests__/render/platform.js';
import { KeplerFileSystem, files, resetFiles } from '../../__tests__/render/files.js';
import { all, button, buttons, fontSize, headers, illegible, preferred, press, render, settle, textOf, type Node } from '../../__tests__/render/render.js';

vi.mock('@amazon-devices/react-native-kepler', () => import('../../__tests__/render/platform.js'));
vi.mock('@amazon-devices/kepler-file-system', () => import('../../__tests__/render/files.js'));

afterEach(() => {
  resetPlatform();
  resetFiles();
});

/** The card where the app draws it: its press goes to the provider, and Back puts it away. */
function OnTheTelevision({ language, onClose }: { readonly language: HouseholdLanguage; readonly onClose: () => void }): React.JSX.Element {
  const seeing = useSeeing();
  const [focusId, setFocusId] = React.useState<string | undefined>(undefined);
  return (
    <SeeingCard
      language={language}
      focusId={focusId}
      onAction={(id) => {
        setFocusId(id);
        if (seeing.press(id)) onClose();
      }}
    />
  );
}

async function launch(language: HouseholdLanguage = 'en', onClose: () => void = () => undefined) {
  return render(
    <SeeingProvider>
      <OnTheTelevision language={language} onClose={onClose} />
    </SeeingProvider>,
  );
}

const labels = (root: Node): string[] => buttons(root).map((b) => textOf(b));

describe('the Easier to see card', () => {
  it('has exactly three buttons, each saying how its setting stands, Back last; the first holds the focus', async () => {
    const { root } = await launch();

    expect(headers(root).map(textOf)).toEqual(['Easier to see']);
    expect(labels(root)).toEqual(['Larger text: off', 'Higher contrast: off', 'Back']);
    expect(preferred(root)).toEqual(['Larger text: off']);
  });

  it('says it all in Spanish when that is her language', async () => {
    const { root } = await launch('es');
    expect(headers(root).map(textOf)).toEqual(['Más fácil de ver']);
    expect(labels(root)).toEqual(['Letra más grande: no', 'Más contraste: no', 'Atrás']);
  });

  it('makes every word larger at once — the card itself included — when she turns larger text on, and keeps the focus where she pressed', async () => {
    const { root } = await launch();
    expect(fontSize(headers(root)[0]!)).toBe(48);

    await press(button(root, 'Larger text: off'));

    expect(labels(root)).toEqual(['Larger text: on', 'Higher contrast: off', 'Back']);
    expect(fontSize(headers(root)[0]!)).toBe(60);
    expect(illegible(root, { largerText: true, higherContrast: false })).toEqual([]);
    expect(preferred(root)).toEqual(['Larger text: on']);
  });

  it('turns the whole card black and white, at 15:1 or better, when she turns higher contrast on', async () => {
    const { root } = await launch();
    await press(button(root, 'Higher contrast: off'));

    expect(labels(root)).toEqual(['Larger text: off', 'Higher contrast: on', 'Back']);
    expect(illegible(root, { largerText: false, higherContrast: true })).toEqual([]);
    expect(preferred(root)).toEqual(['Higher contrast: on']);
  });

  it('puts the card away on Back and changes nothing', async () => {
    const onClose = vi.fn();
    const { root } = await launch('en', onClose);
    await press(button(root, 'Back'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(labels(root)).toEqual(['Larger text: off', 'Higher contrast: off', 'Back']);
    expect(files.has(SEEING_PATH)).toBe(false);
  });
});

describe('her choice, kept on the television', () => {
  it('is written down when she presses, and the next launch is drawn with it from the first frame', async () => {
    const first = await launch();
    await press(button(first.root, 'Larger text: off'));
    expect(JSON.parse(files.get(SEEING_PATH)!)).toEqual({ largerText: true });
    await first.unmount();

    const second = await launch();
    expect(labels(second.root)).toEqual(['Larger text: on', 'Higher contrast: off', 'Back']);
    expect(fontSize(headers(second.root)[0]!)).toBe(60);
  });

  it('draws nothing but the ground until it has been read back — so a launch never begins at one size and jumps to another', async () => {
    let answer: (content: string) => void = () => undefined;
    files.set(SEEING_PATH, '{"largerText":true}');
    const read = vi.spyOn(KeplerFileSystem, 'readFileAsString').mockImplementation(() => new Promise((resolve) => (answer = resolve)));

    const { root } = await launch();
    expect(all(root, 'Text').length).toBe(0);
    expect(all(root, 'View').length).toBe(1);
    expect(all(root, 'View')[0]!.props.style).toMatchObject({ backgroundColor: calmTheme().palette.ground });

    await settle(() => answer('{"largerText":true}'));
    expect(labels(root)).toEqual(['Larger text: on', 'Higher contrast: off', 'Back']);
    read.mockRestore();
  });
});

describe('what the platform says', () => {
  it('turns higher contrast on by default when the television’s own high-contrast text is on', async () => {
    accessibility.highTextContrast = true;
    const { root } = await launch();

    expect(labels(root)).toEqual(['Larger text: off', 'Higher contrast: on', 'Back']);
    expect(illegible(root, { largerText: false, higherContrast: true })).toEqual([]);
  });

  it('gives way to her press: she turns it off, and it stays off', async () => {
    accessibility.highTextContrast = true;
    const { root } = await launch();
    await press(button(root, 'Higher contrast: on'));

    expect(labels(root)).toEqual(['Larger text: off', 'Higher contrast: off', 'Back']);
    expect(JSON.parse(files.get(SEEING_PATH)!)).toEqual({ higherContrast: false });
  });
});
