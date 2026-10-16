/**
 * CalmCard's one hook is the theme it is drawn in; `renderCalmCard` is the
 * card in a theme it is handed, so it can be called as a function and its
 * element tree read directly — no renderer, no device. The platform components are
 * stood in for by their names; what is checked is what CalmCard asks of
 * them: roles, labels, focus, colours, line limits, and what it refuses.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderCalmCard, type CalmCardProps } from '../CalmCard.js';
import { CalmViolation, contrastRatio } from '../constraints.js';
import { calmTheme, type CalmPreferences } from '../theme.js';
import { highContrastPalette, palette } from '../tokens.js';

vi.mock('@amazon-devices/react-native-kepler', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  Animated: { View: 'Animated.View', Value: class {}, timing: () => ({ start: () => undefined }) },
  StyleSheet: { create: <T>(styles: T): T => styles },
  AccessibilityInfo: {},
}));

type Props = CalmCardProps;
type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

const actions: Props['actions'] = [
  { id: 'answer', label: 'Answer', kind: 'primary' },
  { id: 'later', label: 'Later', kind: 'secondary' },
  { id: 'dismiss', label: 'Not now', kind: 'dismiss' },
];

const STANDARD: CalmPreferences = { largerText: false, higherContrast: false };

function card(overrides: Partial<Props> = {}, preferences: CalmPreferences = STANDARD): Element {
  return renderCalmCard({ headline: 'Someone is at the door', actions, onAction: () => undefined, ...overrides }, calmTheme(preferences)) as Element;
}

/** Every element in the tree, depth first. */
function all(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as Element;
  return [element, ...all(element.props.children)];
}

const ofType = (tree: Element, type: string): Element[] => all(tree).filter((e) => e.type === type);

/** A style prop flattened the way React Native would: arrays merged, falsy entries skipped. */
function flat(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flat));
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

describe('CalmCard', () => {
  it('announces the headline as a header, at headline size or larger', () => {
    const [headline] = ofType(card(), 'Text');
    expect(headline?.props.children).toBe('Someone is at the door');
    expect(headline?.props.accessibilityRole).toBe('header');
    expect(flat(headline?.props.style).fontSize).toBeGreaterThanOrEqual(48);
  });

  it('refuses a fourth action instead of drawing it', () => {
    const four = [...actions, { id: 'more', label: 'More', kind: 'secondary' as const }];
    expect(() => card({ actions: four })).toThrow(CalmViolation);
  });

  it('makes each action a labelled button, and gives the first the focus', () => {
    const buttons = ofType(card(), 'Pressable');
    expect(buttons.map((b) => b.props.accessibilityRole)).toEqual(['button', 'button', 'button']);
    expect(buttons.map((b) => b.props.accessibilityLabel)).toEqual(['Answer', 'Later', 'Not now']);
    expect(buttons.map((b) => b.props.hasTVPreferredFocus)).toEqual([true, false, false]);
  });

  it('puts the focus where it is asked to', () => {
    const buttons = ofType(card({ initialFocusId: 'later' }), 'Pressable');
    expect(buttons.map((b) => b.props.hasTVPreferredFocus)).toEqual([false, true, false]);
  });

  it('answers a press with the action’s id', () => {
    const onAction = vi.fn();
    const [, later] = ofType(card({ onAction }), 'Pressable');
    (later?.props.onPress as () => void)();
    expect(onAction).toHaveBeenCalledWith('later');
  });

  it('shows focus as a ring in the focus colour, not as a change of colour alone', () => {
    const [first] = ofType(card(), 'Pressable');
    const style = first?.props.style as (state: { focused: boolean }) => unknown;
    expect(flat(style({ focused: false })).borderColor).toBe('transparent');
    expect(flat(style({ focused: true })).borderColor).toBe(palette.focus);
    expect(flat(style({ focused: true })).borderWidth).toBeGreaterThanOrEqual(2);
  });

  it('writes every button’s words at 7:1 or better against that button', () => {
    const buttons = ofType(card(), 'Pressable');
    for (const button of buttons) {
      const background = flat((button.props.style as (s: { focused: boolean }) => unknown)({ focused: false }))
        .backgroundColor as string;
      const [label] = ofType(button, 'Text');
      const colour = flat(label?.props.style).color as string;
      expect(contrastRatio(colour, background)).toBeGreaterThanOrEqual(7);
      expect(flat(label?.props.style).fontSize).toBeGreaterThanOrEqual(32);
    }
  });

  it('shows no detail line at all until there is detail — no placeholder', () => {
    expect(ofType(card(), 'Text')).toHaveLength(1 + actions.length);
  });

  it('cuts the detail at five lines so the buttons stay on screen', () => {
    const detail = ofType(card({ detail: 'A long description. '.repeat(40) }), 'Text')[1];
    expect(detail?.props.numberOfLines).toBe(5);
    expect(flat(detail?.props.style).fontSize).toBeGreaterThanOrEqual(32);
  });

  it('gives a compact card a sixth line, and refuses one on a card with no room for it', () => {
    const detail = ofType(card({ detail: 'Words', compact: true, detailLines: 6 }), 'Text')[1];
    expect(detail?.props.numberOfLines).toBe(6);
    expect(() => card({ detail: 'Words', detailLines: 6 })).toThrow(CalmViolation);
  });
});

describe('CalmCard, drawn with what the viewer asked for', () => {
  const LARGER: CalmPreferences = { largerText: true, higherContrast: false };
  const HIGH: CalmPreferences = { largerText: false, higherContrast: true };

  it('sets every word 1.25 times larger with larger text on: the floor becomes 40pt', () => {
    const tree = card({ detail: 'She is holding a bag of shopping.' }, LARGER);
    const [headline, detail, ...labels] = ofType(tree, 'Text');
    expect(flat(headline?.props.style).fontSize).toBe(60);
    expect(flat(detail?.props.style).fontSize).toBe(40);
    for (const label of labels) expect(flat(label.props.style).fontSize).toBe(40);
  });

  it('writes every word white on black with higher contrast on, at 15:1 or better', () => {
    const tree = card({ detail: 'She is holding a bag of shopping.' }, HIGH);
    const [box] = ofType(tree, 'View');
    const ground = flat(box?.props.style).backgroundColor as string;
    expect(ground).toBe(highContrastPalette.raised);
    const [headline, detail] = ofType(tree, 'Text');
    for (const text of [headline, detail]) expect(contrastRatio(flat(text?.props.style).color as string, ground)).toBeGreaterThanOrEqual(15);
    for (const button of ofType(tree, 'Pressable')) {
      const background = flat((button.props.style as (s: { focused: boolean }) => unknown)({ focused: false })).backgroundColor as string;
      const [label] = ofType(button, 'Text');
      expect(contrastRatio(flat(label?.props.style).color as string, background)).toBeGreaterThanOrEqual(15);
    }
  });

  it('gives a black card a white edge with higher contrast on, so it stands apart from a black screen', () => {
    const [box] = ofType(card({}, HIGH), 'View');
    expect(flat(box?.props.style).borderWidth).toBeGreaterThan(0);
    expect(flat(box?.props.style).borderColor).toBe('#FFFFFF');
  });

  it('draws the focus ring thicker with higher contrast on, and moves nothing when the focus moves', () => {
    const [first] = ofType(card({}, HIGH), 'Pressable');
    const style = first?.props.style as (state: { focused: boolean }) => unknown;
    const rest = flat(style({ focused: false }));
    const focused = flat(style({ focused: true }));
    expect(focused.borderWidth).toBe(6);
    expect(focused.borderColor).toBe('#FFFFFF');
    expect((rest.borderWidth as number) + (rest.margin as number)).toBe((focused.borderWidth as number) + (focused.margin as number));
    const [standard] = ofType(card(), 'Pressable');
    expect(flat((standard?.props.style as (s: { focused: boolean }) => unknown)({ focused: true })).borderWidth).toBe(2);
  });

  it('is drawn at the standard size when its words would not be whole at larger text — never cut, never under 32pt', () => {
    const long = 'A long note from the family that runs on and on. '.repeat(4).trim().slice(0, 240);
    const [headline, detail] = ofType(card({ detail: long }, LARGER), 'Text');
    expect(flat(headline?.props.style).fontSize).toBe(48);
    expect(flat(detail?.props.style).fontSize).toBe(32);
    expect(detail?.props.numberOfLines).toBe(5);
  });

  it('keeps a short card large at larger text, and its words whole', () => {
    const [, detail] = ofType(card({ detail: 'Sarah will ring at six.' }, LARGER), 'Text');
    expect(flat(detail?.props.style).fontSize).toBe(40);
    expect(detail?.props.numberOfLines).toBeGreaterThanOrEqual(1);
  });

  it('keeps higher contrast when it falls back from larger text', () => {
    const long = 'word '.repeat(48).trim();
    const [headline] = ofType(card({ detail: long }, { largerText: true, higherContrast: true }), 'Text');
    expect(flat(headline?.props.style).fontSize).toBe(48);
    expect(flat(headline?.props.style).color).toBe('#FFFFFF');
  });

  it('refuses a fourth action at larger text too', () => {
    const four = [...actions, { id: 'more', label: 'More', kind: 'secondary' as const }];
    expect(() => card({ actions: four }, LARGER)).toThrow(CalmViolation);
  });
});
