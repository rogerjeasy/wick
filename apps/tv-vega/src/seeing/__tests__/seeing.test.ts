/**
 * Easier to see (seeing/seeing.ts): the card's three buttons and what a
 * press on each does, what the television is drawn with, what is kept on
 * the disk, and the card's one second.
 */
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '@wick/contracts';
import { PRESS_SETTLE_MS, pressSettle } from '../../press/settle.js';
import { words } from '../../words/words.js';
import { NO_CHOICE, SEEING_ACTIONS, SEEING_CARD, pressSeeing, readSeeing, seeingActions, seeingCardShows, seeingPreferences, writeSeeing } from '../seeing.js';
import { keepSeeing, recallSeeing, type SeeingFileSystem } from '../seeingStore.js';

const say = words('en');
const OFF = { largerText: false, higherContrast: false };

describe('the card’s buttons', () => {
  it('are exactly three — Larger text, Higher contrast, Back — and each of the first two says how it stands', () => {
    const actions = seeingActions(OFF, say);
    expect(actions.map((a) => a.label)).toEqual(['Larger text: off', 'Higher contrast: off', 'Back']);
    expect(actions.map((a) => a.id)).toEqual([SEEING_ACTIONS.largerText, SEEING_ACTIONS.higherContrast, SEEING_ACTIONS.back]);
    expect(seeingActions({ largerText: true, higherContrast: true }, say).map((a) => a.label)).toEqual(['Larger text: on', 'Higher contrast: on', 'Back']);
  });

  it('are said in her language, whole', () => {
    expect(seeingActions({ largerText: true, higherContrast: false }, words('es')).map((a) => a.label)).toEqual(['Letra más grande: sí', 'Más contraste: no', 'Atrás']);
    for (const language of LANGUAGES) expect(seeingActions(OFF, words(language))).toHaveLength(3);
  });

  it('give the focus to the first, and Back is the quiet one', () => {
    expect(seeingActions(OFF, say).map((a) => a.kind)).toEqual(['primary', 'secondary', 'dismiss']);
  });
});

describe('a press', () => {
  it('turns larger text on, then off again, and changes nothing else', () => {
    const on = pressSeeing(NO_CHOICE, OFF, SEEING_ACTIONS.largerText);
    expect(on).toEqual({ choice: { largerText: true }, close: false });
    const off = pressSeeing(on.choice, seeingPreferences(on.choice, { higherContrast: false }), SEEING_ACTIONS.largerText);
    expect(off.choice).toEqual({ largerText: false });
  });

  it('turns higher contrast the other way from how it stands — the platform’s own setting included', () => {
    const fromPlatform = seeingPreferences(NO_CHOICE, { higherContrast: true });
    expect(fromPlatform.higherContrast).toBe(true);
    expect(pressSeeing(NO_CHOICE, fromPlatform, SEEING_ACTIONS.higherContrast).choice).toEqual({ higherContrast: false });
  });

  it('on Back closes the card and changes nothing', () => {
    const choice = { largerText: true };
    const back = pressSeeing(choice, OFF, SEEING_ACTIONS.back);
    expect(back.close).toBe(true);
    expect(back.choice).toBe(choice);
  });

  it('of anything else does nothing at all', () => {
    expect(pressSeeing(NO_CHOICE, OFF, 'reply_0')).toEqual({ choice: NO_CHOICE, close: false });
  });
});

describe('what the television is drawn with', () => {
  it('is the floor until anything says otherwise', () => {
    expect(seeingPreferences(NO_CHOICE, { higherContrast: false })).toEqual(OFF);
  });

  it('follows the platform’s high-contrast setting until she has pressed', () => {
    expect(seeingPreferences(NO_CHOICE, { higherContrast: true }).higherContrast).toBe(true);
  });

  it('is her choice once she has made one, whatever the platform says', () => {
    expect(seeingPreferences({ higherContrast: false }, { higherContrast: true }).higherContrast).toBe(false);
    expect(seeingPreferences({ higherContrast: true }, { higherContrast: false }).higherContrast).toBe(true);
    expect(seeingPreferences({ largerText: true }, { higherContrast: false }).largerText).toBe(true);
  });
});

describe('what is kept', () => {
  it('is only what she pressed', () => {
    expect(writeSeeing(NO_CHOICE)).toBe('{}');
    expect(readSeeing(writeSeeing({ largerText: true }))).toEqual({ largerText: true });
    expect(readSeeing(writeSeeing({ largerText: false, higherContrast: true }))).toEqual({ largerText: false, higherContrast: true });
  });

  it('is nothing, for anything that is not her choice', () => {
    for (const raw of ['', 'not json', 'null', '[]', '{"largerText":"yes"}', '42']) expect(readSeeing(raw), raw).toEqual({});
  });

  it('is written to the app’s own file store and read back at the next launch', async () => {
    const files = new Map<string, string>();
    const fs: SeeingFileSystem = {
      exists: async (path) => files.has(path),
      readFileAsString: async (path) => files.get(path) ?? '',
      writeStringToFile: async (path, content) => {
        files.set(path, content);
        return content.length;
      },
    };
    expect(await recallSeeing(fs)).toEqual({});
    await keepSeeing(fs, { largerText: true });
    expect([...files.keys()]).toEqual(['/data/wick-seeing.json']);
    expect(await recallSeeing(fs)).toEqual({ largerText: true });
  });

  it('is forgotten, calmly, by a disk that keeps nothing — the Vega Virtual Device’s (FL-013)', async () => {
    const broken: SeeingFileSystem = {
      exists: async () => {
        throw new Error('no data root');
      },
      readFileAsString: async () => '',
      writeStringToFile: async () => {
        throw new Error('no data root');
      },
    };
    await expect(keepSeeing(broken, { largerText: true })).resolves.toBeUndefined();
    await expect(recallSeeing(broken)).resolves.toEqual({});
  });
});

describe('the card on screen', () => {
  it('is there while she has it open and nothing has come over it', () => {
    expect(seeingCardShows({ open: true, card: false, liveOpen: false })).toBe(true);
    expect(seeingCardShows({ open: false, card: false, liveOpen: false })).toBe(false);
  });

  it('gives way to a card from the server — the door above all — and to the door camera', () => {
    expect(seeingCardShows({ open: true, card: true, liveOpen: false })).toBe(false);
    expect(seeingCardShows({ open: true, card: false, liveOpen: true })).toBe(false);
  });

  it('takes no press in its first second, then takes them all — a toggle does not start the second again', () => {
    const settle = pressSettle();
    settle.appeared(SEEING_CARD, 10_000);
    expect(settle.acts(10_000 + PRESS_SETTLE_MS - 1)).toBe(false);
    expect(settle.acts(10_000 + PRESS_SETTLE_MS)).toBe(true);
    // The same card drawn again — larger, or in black and white — is the same card: its buttons stay live.
    settle.appeared(SEEING_CARD, 11_500);
    expect(settle.acts(11_600)).toBe(true);
  });

  it('starts its second again when it comes back from under the door’s card', () => {
    const settle = pressSettle();
    settle.appeared(SEEING_CARD, 0);
    settle.appeared('door-1', 5_000);
    settle.appeared(SEEING_CARD, 9_000);
    expect(settle.acts(9_500)).toBe(false);
    expect(settle.acts(10_000)).toBe(true);
  });
});
