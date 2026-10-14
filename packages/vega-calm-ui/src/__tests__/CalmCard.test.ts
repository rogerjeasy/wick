/**
 * CalmCard has no hooks, so it can be called as a function and its element
 * tree read directly — no renderer, no device. The platform components are
 * stood in for by their names; what is checked is what CalmCard asks of
 * them: roles, labels, focus, colours, line limits, and what it refuses.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { CalmCard } from '../CalmCard.js';
import { CalmViolation, contrastRatio } from '../constraints.js';
import { palette } from '../tokens.js';

vi.mock('@amazon-devices/react-native-kepler', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  Animated: { View: 'Animated.View', Value: class {}, timing: () => ({ start: () => undefined }) },
  StyleSheet: { create: <T>(styles: T): T => styles },
  AccessibilityInfo: {},
}));

type Props = Parameters<typeof CalmCard>[0];
type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

const actions: Props['actions'] = [
  { id: 'answer', label: 'Answer', kind: 'primary' },
  { id: 'later', label: 'Later', kind: 'secondary' },
  { id: 'dismiss', label: 'Not now', kind: 'dismiss' },
];

function card(overrides: Partial<Props> = {}): Element {
  return CalmCard({ headline: 'Someone is at the door', actions, onAction: () => undefined, ...overrides }) as Element;
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
