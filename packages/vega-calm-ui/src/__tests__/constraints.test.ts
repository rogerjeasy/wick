import { describe, it, expect } from 'vitest';
import {
  CalmViolation,
  assertActionLimit,
  assertItemLimit,
  assertContrast,
  assertNoAlarmColour,
  contrastRatio,
  fontSize,
  maxCardHeightDp,
  actionColours,
} from '../constraints.js';
import { layout, palette, type } from '../tokens.js';

describe('action and item limits', () => {
  it('allows three and refuses four', () => {
    expect(() => assertActionLimit(3)).not.toThrow();
    expect(() => assertActionLimit(4)).toThrow(CalmViolation);
    expect(() => assertItemLimit(3)).not.toThrow();
    expect(() => assertItemLimit(4)).toThrow(CalmViolation);
  });
});

describe('card height', () => {
  it('keeps the buttons on screen: the tallest card still fits a 540dp television', () => {
    expect(maxCardHeightDp()).toBeLessThanOrEqual(layout.screenHeightDp);
  });
});

describe('type scale', () => {
  it('never returns anything below the 32pt floor', () => {
    for (const role of ['body', 'headline', 'display'] as const) {
      expect(fontSize(role)).toBeGreaterThanOrEqual(type.bodyPt);
    }
  });
});

describe('contrast', () => {
  it('computes known WCAG ratios', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 1);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });

  it('passes every foreground in our own palette against the ground', () => {
    // If a token is ever edited below AAA, this fails before a screen does.
    for (const fg of [palette.ink, palette.inkDim, palette.accent]) {
      expect(() => assertContrast(fg, palette.ground)).not.toThrow();
    }
  });

  it('refuses a pairing below 7:1 even when it would pass AA', () => {
    // ~4.6:1 — comfortably AA, and not good enough here.
    expect(() => assertContrast('#767676', '#FFFFFF')).toThrow(CalmViolation);
  });
});

describe('no red', () => {
  it('rejects reds by hue, not by a list of known values', () => {
    for (const red of ['#FF0000', '#E53935', '#C62828', '#FF3B30', '#8B0000']) {
      expect(() => assertNoAlarmColour(red)).toThrow(CalmViolation);
    }
  });

  it('accepts the palette, including the warm accent', () => {
    for (const ok of Object.values(palette)) {
      expect(() => assertNoAlarmColour(ok)).not.toThrow();
    }
  });

  it('accepts greys, warm ambers and desaturated clays', () => {
    for (const ok of ['#1E1B17', '#E8B75D', '#C8C2B6', '#FFFFFF', '#A08070']) {
      expect(() => assertNoAlarmColour(ok)).not.toThrow();
    }
  });

  it('rejects a malformed colour rather than passing it through', () => {
    expect(() => assertNoAlarmColour('red')).toThrow(CalmViolation);
    expect(() => assertNoAlarmColour('#FFF')).toThrow(CalmViolation);
  });
});

describe('actionColours — a button’s words against the button itself', () => {
  it('holds the 7:1 floor on every kind of button — not only on the card behind it', () => {
    for (const kind of ['primary', 'secondary', 'dismiss'] as const) {
      const { background, label } = actionColours(kind);
      expect(contrastRatio(label, background)).toBeGreaterThanOrEqual(7);
      expect(() => assertContrast(label, background)).not.toThrow();
    }
  });

  it('writes dark on the amber of the first button: light ink there was 1.6:1, and it is the button she is most likely to press', () => {
    expect(contrastRatio(palette.ink, palette.accent)).toBeLessThan(2);
    expect(actionColours('primary')).toEqual({ background: palette.accent, label: palette.ground });
  });

  it('leaves the other buttons as they were', () => {
    expect(actionColours('secondary')).toEqual({ background: palette.ground, label: palette.ink });
    expect(actionColours('dismiss')).toEqual({ background: palette.ground, label: palette.ink });
  });
});

