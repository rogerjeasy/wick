/**
 * Rendering a screen in a test, and reading what it drew — for tests only.
 *
 * `render` mounts an element with React's test renderer: the real
 * reconciler, so every hook, effect and state change runs as it does on the
 * television. The platform underneath is the stand-in in platform.ts, so
 * what can be read is what the screen asked the platform for: which words
 * it wrote and at what size and colour, which buttons it offered, with what
 * label and role, where the focus was asked to start, and what a press does.
 *
 * Everything is done inside `act`, and awaited: an effect that asks the
 * platform something, and the state its answer sets, have both happened by
 * the time `render` or `press` returns.
 */
import type { ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { contrastRatio } from '@wick/vega-calm-ui';

// React's own switches for a test: `act` is how updates are flushed here, and this renderer is drawing a
// React Native tree (which is also what keeps React 19 from warning that the renderer is deprecated for the web).
const flags = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; IS_REACT_NATIVE_TEST_ENVIRONMENT?: boolean };
flags.IS_REACT_ACT_ENVIRONMENT = true;
flags.IS_REACT_NATIVE_TEST_ENVIRONMENT = true;

export type Node = ReactTestInstance;

export interface Drawn {
  readonly renderer: ReactTestRenderer;
  readonly root: Node;
  /** Draws it again with new props. */
  update(element: ReactElement): Promise<void>;
  unmount(): Promise<void>;
}

/** Mounts `element`, runs its effects and whatever they awaited, and hands back what was drawn. */
export async function render(element: ReactElement): Promise<Drawn> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(element);
  });
  const drawn = renderer!;
  return {
    renderer: drawn,
    get root() {
      return drawn.root;
    },
    update: async (next) => {
      await act(async () => {
        drawn.update(next);
      });
    },
    unmount: async () => {
      await act(async () => {
        drawn.unmount();
      });
    },
  };
}

/** Lets timers and promises a screen started run, inside `act`. */
export async function settle(run: () => void | Promise<void> = () => undefined): Promise<void> {
  await act(async () => {
    await run();
  });
}

// ---------------------------------------------------------------------------
// Reading the tree.
// ---------------------------------------------------------------------------

/** Every host component of that kind — `Text`, `Pressable`, `Image`, `View` — in the order it is drawn. */
export function all(root: Node, type: string): Node[] {
  return root.findAll((node) => node.type === type);
}

/** The words inside a node, run together as the screen reader would meet them. */
export function textOf(node: Node | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(textOf).join('');
}

/** Every line of words drawn: each outermost `Text`, as one string. */
export function texts(root: Node): string[] {
  return all(root, 'Text')
    .filter((text) => !hasAncestor(text, 'Text'))
    .map(textOf);
}

/** Whether `words` are drawn anywhere on the screen. */
export function shows(root: Node, words: string): boolean {
  return texts(root).some((line) => line.includes(words));
}

/** Everything that can be pressed. */
export function buttons(root: Node): Node[] {
  return all(root, 'Pressable');
}

/** The button with this accessibility label. Throws when there is none, or more than one. */
export function button(root: Node, label: string): Node {
  const found = buttons(root).filter((b) => b.props.accessibilityLabel === label);
  if (found.length !== 1) throw new Error(`${found.length} buttons labelled "${label}"; there are: ${buttons(root).map((b) => String(b.props.accessibilityLabel)).join(' | ')}`);
  return found[0]!;
}

/** The headline: what the screen marks as a header. */
export function headers(root: Node): Node[] {
  return all(root, 'Text').filter((text) => text.props.accessibilityRole === 'header');
}

/** A press of OK on a button, as the platform hands it over, with whatever it set going inside `act`. */
export async function press(node: Node): Promise<void> {
  const onPress = node.props.onPress as (() => void) | undefined;
  if (!onPress) throw new Error(`${String(node.type)} has no onPress`);
  await act(async () => {
    onPress();
  });
}

/**
 * OK on the remote, down and up, on a button that has the focus — the way
 * the platform tells a Pressable: the key went down, the key came up, and
 * at once, pressed. (`press` is a press with no key: the platform's click,
 * or a screen reader's.)
 */
export async function pressOk(node: Node): Promise<void> {
  const call = (name: string): void => (node.props[name] as (() => void) | undefined)?.();
  await act(async () => call('onPressIn'));
  await act(async () => {
    call('onPressOut');
    call('onPress');
  });
}

/** The focus arrives on a node, as the D-pad brings it there. */
export async function focus(node: Node): Promise<void> {
  await act(async () => {
    (node.props.onFocus as (() => void) | undefined)?.();
  });
}

/**
 * Where the focus is asked to start: everything the screen marks with
 * `hasTVPreferredFocus`, by name (`named`).
 */
export function preferred(root: Node): string[] {
  return root.findAll((node) => typeof node.type === 'string' && node.props.hasTVPreferredFocus === true).map(named);
}

/**
 * A node in a few words — its label, or its kind and its words — for an
 * assertion to compare. Compare these, or counts, never nodes themselves:
 * a node reaches the whole tree, and a failing assertion that prints one
 * runs the test worker out of memory.
 */
export function named(node: Node): string {
  const label = node.props.accessibilityLabel;
  return typeof label === 'string' ? label : `${String(node.type)}: ${textOf(node)}`;
}

// ---------------------------------------------------------------------------
// Reading styles.
// ---------------------------------------------------------------------------

/**
 * A style as the platform would apply it: arrays merged, falsy entries
 * skipped — and a Pressable's style, which is a function of its state,
 * asked for in that state (at rest unless said).
 */
export function flat(style: unknown, state: { readonly focused: boolean } = { focused: false }): Record<string, unknown> {
  if (typeof style === 'function') return flat((style as (s: { focused: boolean }) => unknown)(state), state);
  if (Array.isArray(style)) return Object.assign({}, ...style.map((part) => flat(part, state)));
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

/** The size a line of words is set at. */
export function fontSize(text: Node): number {
  return flat(text.props.style).fontSize as number;
}

/** The colour a node is drawn on: its own background, or the nearest one behind it. */
export function groundOf(node: Node): string | undefined {
  for (let at: Node | null = node; at; at = at.parent) {
    if (typeof at.type !== 'string') continue;
    const background = flat(at.props.style).backgroundColor;
    if (typeof background === 'string' && background !== 'transparent') return background;
  }
  return undefined;
}

/** How a line of words stands out from what it is written on. */
export function contrastOf(text: Node): number {
  const colour = flat(text.props.style).color as string;
  const ground = groundOf(text);
  if (!colour || !ground) throw new Error(`"${textOf(text)}" has no colour (${colour}) or nothing behind it (${ground})`);
  return contrastRatio(colour, ground);
}

function hasAncestor(node: Node, type: string): boolean {
  for (let at = node.parent; at; at = at.parent) if (at.type === type) return true;
  return false;
}
