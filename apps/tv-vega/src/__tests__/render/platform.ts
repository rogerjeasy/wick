/**
 * The television's platform, stood in for, so a screen can be rendered in
 * Node — for tests only.
 *
 * `@amazon-devices/react-native-kepler` and `react-native` cannot be loaded
 * outside the Vega bundler: they are Flow source over native modules. So a
 * render test hands them this instead, the way vega-calm-ui's own CalmCard
 * test does:
 *
 *   vi.mock('@amazon-devices/react-native-kepler', () => import('../../__tests__/render/platform.js'));
 *   vi.mock('react-native', () => import('../../__tests__/render/platform.js'));
 *
 * Every component is a host component named for what it stands in for —
 * `View`, `Text`, `Pressable`, `Image` — so React's own reconciler runs the
 * screen for real (its hooks, its effects, its state) and the test reads
 * what the screen asked the platform for: the props each host was given.
 * Nothing is laid out and nothing is painted; a test checks roles, labels,
 * focus, sizes, colours and what a press calls.
 *
 * The parts of the platform a screen listens to — Back, the remote's keys,
 * the accessibility settings — are kept here, so a test can say what the
 * platform says (`pressBack`, `sendKey`, `accessibility`) and `resetPlatform`
 * puts it back between tests.
 */
import * as React from 'react';

// ---------------------------------------------------------------------------
// What is drawn: host components, by name.
// ---------------------------------------------------------------------------

export const View = 'View';
export const Text = 'Text';
export const Pressable = 'Pressable';
export const Image = 'Image';
export const ScrollView = 'ScrollView';
export const TVFocusGuideView = 'TVFocusGuideView';

const absoluteFill = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } as const;

export const StyleSheet = {
  create: <T>(styles: T): T => styles,
  absoluteFill,
  absoluteFillObject: absoluteFill,
  flatten: (style: unknown): Record<string, unknown> => flatten(style),
  hairlineWidth: 1,
};

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

/**
 * Animated, without the animation: a value is set to where its timing ends
 * the moment the timing is started. What is checked is that the screen asks
 * for the fade; how it looks halfway through is the platform's.
 */
class AnimatedValue {
  constructor(public value: number) {}
  setValue(value: number): void {
    this.value = value;
  }
}

export const Animated = {
  View: 'Animated.View',
  Value: AnimatedValue,
  timing: (value: AnimatedValue, config: { readonly toValue: number }) => ({
    start: (done?: (result: { finished: boolean }) => void) => {
      value.setValue(config.toValue);
      done?.({ finished: true });
    },
  }),
};

/** The Vega Virtual Device's screen: 960x540dp at 1080p. */
export const Dimensions = {
  get: () => ({ width: 960, height: 540, scale: 2, fontScale: 1 }),
  addEventListener: () => ({ remove: () => undefined }),
};

export const Platform = { OS: 'kepler', select: <T>(choices: { readonly kepler?: T; readonly default?: T }): T | undefined => choices.kepler ?? choices.default };

// ---------------------------------------------------------------------------
// What the platform says, and what a screen says to it.
// ---------------------------------------------------------------------------

/** The viewer's accessibility settings as the platform reports them, and what was announced. Set before rendering. */
export const accessibility = {
  screenReader: false,
  reduceMotion: false,
  highTextContrast: false,
  announced: [] as string[],
};

export const AccessibilityInfo = {
  isScreenReaderEnabled: () => Promise.resolve(accessibility.screenReader),
  isReduceMotionEnabled: () => Promise.resolve(accessibility.reduceMotion),
  isHighTextContrastEnabled: () => Promise.resolve(accessibility.highTextContrast),
  addEventListener: () => ({ remove: () => undefined }),
  announceForAccessibility: (sentence: string) => {
    accessibility.announced.push(sentence);
  },
};

type BackListener = () => boolean | null | undefined;
const backListeners: BackListener[] = [];

/** Back, as the platform hands it out: the listener added last is asked first, and the first to answer true has it. */
export const BackHandler = {
  addEventListener: (_event: 'hardwareBackPress', listener: BackListener) => {
    backListeners.push(listener);
    return {
      remove: () => {
        const at = backListeners.lastIndexOf(listener);
        if (at >= 0) backListeners.splice(at, 1);
      },
    };
  },
  exitApp: () => undefined,
};

/** The remote's Back key. True when something on screen took it. */
export function pressBack(): boolean {
  for (const listener of [...backListeners].reverse()) {
    if (listener()) return true;
  }
  return false;
}

/** What `useTVEventHandler` hands a screen: the key, and whether it went down (0) or came up (1). */
export interface KeyEvent {
  readonly eventType: string;
  readonly eventKeyAction?: number;
}

const keyListeners = new Set<(event: KeyEvent) => void>();

/** Every key, wherever the focus is — as Vega's hook gives it, to every screen that asked. */
export function useTVEventHandler(handler: (event: KeyEvent) => void): void {
  const latest = React.useRef(handler);
  latest.current = handler;
  React.useEffect(() => {
    const listener = (event: KeyEvent): void => latest.current(event);
    keyListeners.add(listener);
    return () => {
      keyListeners.delete(listener);
    };
  }, []);
}

/** A key on the remote, heard by every screen listening. Call inside `act`. */
export function sendKey(event: KeyEvent): void {
  for (const listener of [...keyListeners]) listener(event);
}

/** The addresses the app asked the platform to open (another app, its own service). */
export const opened: string[] = [];

export const Linking = {
  openURL: (url: string): Promise<void> => {
    opened.push(url);
    return Promise.resolve();
  },
};

/** Wick is the app in front, unless a test says otherwise. */
export const AppState = {
  currentState: 'active',
  addEventListener: () => ({ remove: () => undefined }),
};

/** Back to how the platform starts: nothing listening, nothing announced, every setting off. */
export function resetPlatform(): void {
  accessibility.screenReader = false;
  accessibility.reduceMotion = false;
  accessibility.highTextContrast = false;
  accessibility.announced.length = 0;
  backListeners.length = 0;
  keyListeners.clear();
  opened.length = 0;
}
