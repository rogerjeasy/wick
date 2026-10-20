/**
 * The icons (icons/icons.ts, scripts/tv-icons.mjs): every one the
 * television draws has its pictures, in both tones and both sizes, and the
 * one drawn follows the theme she chose.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { calmTheme } from '../../../../../packages/vega-calm-ui/src/theme.js';
import { ICON_NAMES, ICON_SIZES_DP, iconKey, iconSizeDp } from '../icons.js';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const generated = readFileSync(join(APP, 'src/icons/iconSources.generated.ts'), 'utf8');

describe('the icons', () => {
  it('has a picture for each, in both tones and both sizes, and requires it for the bundler', () => {
    for (const name of ICON_NAMES) {
      for (const tone of ['ink', 'ground']) {
        for (const dp of ICON_SIZES_DP) {
          const file = `${name}-${tone}-${dp}.png`;
          expect(existsSync(join(APP, 'assets/icons', file)), file).toBe(true);
          expect(generated).toContain(`'${name}-${tone}-${dp}': require('../../assets/icons/${file}')`);
        }
      }
    }
  });

  it('draws each picture at twice its size in pixels, for a 1080p panel', () => {
    for (const dp of ICON_SIZES_DP) {
      const png = readFileSync(join(APP, 'assets/icons', `door-ink-${dp}.png`));
      // A PNG's width and height are the two big-endian words after the IHDR tag.
      expect(png.readUInt32BE(16)).toBe(dp * 2);
      expect(png.readUInt32BE(20)).toBe(dp * 2);
    }
  });

  it('is as tall as a line of body text: 32dp, and 40dp with larger text on', () => {
    expect(iconSizeDp(calmTheme())).toBe(32);
    expect(iconSizeDp(calmTheme({ largerText: true, higherContrast: false }))).toBe(40);
    expect(iconKey('tour', 'ink', calmTheme({ largerText: true, higherContrast: false }))).toBe('tour-ink-40');
  });

  it('is drawn in ink on the black first button of higher contrast, never in the dark of the ground', () => {
    expect(iconKey('play', 'ground', calmTheme())).toBe('play-ground-32');
    expect(iconKey('play', 'ground', calmTheme({ largerText: false, higherContrast: true }))).toBe('play-ink-32');
  });
});
