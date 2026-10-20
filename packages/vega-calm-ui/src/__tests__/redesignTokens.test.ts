/**
 * The colours and motion the redesign added (docs/design/DESIGN.md §2 and
 * §4): a focused surface, a progress line's track, the scrim behind a card
 * over a film, and the timings every animation is made from — held to the
 * same floor as everything else.
 */
import { describe, expect, it } from 'vitest';
import { alarmHue, contrastRatio } from '../constraints.js';
import { calmTheme, motionTimings, textPairs, type CalmPreferences } from '../theme.js';
import { highContrastPalette, limits, motion, palette, type } from '../tokens.js';

const EVERY: readonly CalmPreferences[] = [
  { largerText: false, higherContrast: false },
  { largerText: true, higherContrast: false },
  { largerText: false, higherContrast: true },
  { largerText: true, higherContrast: true },
];

describe('the new colours', () => {
  it('are the design system’s values', () => {
    expect(palette.raisedHigh).toBe('#2A2621');
    expect(palette.track).toBe('#4A443B');
    expect(palette.scrim).toBe('#12100E');
    expect(calmTheme().scrimOpacity).toBe(0.82);
  });

  it('keep every word at 7:1 on the focused surface — and at 15:1 with higher contrast on', () => {
    for (const p of EVERY) {
      const t = calmTheme(p);
      const pairs = textPairs(t);
      expect(pairs).toContainEqual([t.palette.ink, t.palette.raisedHigh]);
      expect(pairs).toContainEqual([t.palette.inkDim, t.palette.raisedHigh]);
      for (const [fg, bg] of pairs) expect(contrastRatio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(p.higherContrast ? 15 : 7);
    }
    expect(contrastRatio(palette.ink, palette.raisedHigh)).toBeGreaterThan(13);
    expect(contrastRatio(palette.inkDim, palette.raisedHigh)).toBeGreaterThan(8.4);
  });

  it('keep the accent fill visible against its track', () => {
    expect(contrastRatio(palette.accent, palette.track)).toBeGreaterThan(3);
  });

  it('are black and white with higher contrast on, and the track is outlined so it is still seen', () => {
    expect(new Set(Object.values(highContrastPalette))).toEqual(new Set(['#FFFFFF', '#000000']));
    const high = calmTheme({ largerText: false, higherContrast: true });
    expect(high.trackEdgeDp).toBeGreaterThan(0);
    expect(calmTheme().trackEdgeDp).toBe(0);
    expect(high.scrimOpacity).toBeGreaterThanOrEqual(calmTheme().scrimOpacity);
  });

  it('are never red', () => {
    for (const colour of [...Object.values(palette), ...Object.values(highContrastPalette)]) expect(alarmHue(colour), colour).toBeNull();
  });
});

describe('motion', () => {
  it('is the design system’s: 200ms in, 150ms out, 150ms to the focus at 1.04, 12dp of rise', () => {
    expect(motion).toMatchObject({ enterMs: 200, exitMs: 150, focusMs: 150, focusScale: 1.04, enterRiseDp: 12 });
    expect(motion.easing).toEqual([0.2, 0, 0, 1]);
  });

  it('is never longer than 200ms', () => {
    for (const ms of [motion.enterMs, motion.exitMs, motion.focusMs, motion.durationMs]) expect(ms).toBeLessThanOrEqual(200);
  });

  it('is an instant change with reduced motion asked for — and the focused tile is still larger', () => {
    expect(motionTimings(true)).toEqual({ enterMs: 0, exitMs: 0, focusMs: 0, enterRiseDp: 0, focusScale: 1.04 });
    expect(motionTimings(false)).toEqual({ enterMs: 200, exitMs: 150, focusMs: 150, enterRiseDp: 12, focusScale: 1.04 });
  });

  it('leaves the floor where it was: 32pt, three actions', () => {
    expect(type.bodyPt).toBe(32);
    expect(limits.maxActions).toBe(3);
  });
});
