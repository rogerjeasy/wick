/**
 * The hooks are a useEffect around watchAccessibility. These tests check the
 * wiring — that they ask the platform's own AccessibilityInfo, for the right
 * setting, and hand its answers to state — with React's two hooks stood in
 * for, so no renderer is needed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useReduceMotionEnabled, useScreenReaderEnabled } from '../accessibility.js';

const platform = vi.hoisted(() => ({
  isScreenReaderEnabled: vi.fn(() => Promise.resolve(true)),
  isReduceMotionEnabled: vi.fn(() => Promise.resolve(true)),
  addEventListener: vi.fn(() => ({ remove: vi.fn() })),
}));

const react = vi.hoisted(() => ({
  setState: vi.fn(),
  cleanups: [] as (() => void)[],
}));

vi.mock('@amazon-devices/react-native-kepler', () => ({ AccessibilityInfo: platform }));

vi.mock('react', () => ({
  useState: (initial: boolean) => [initial, react.setState],
  useEffect: (effect: () => (() => void) | void) => {
    const cleanup = effect();
    if (cleanup) react.cleanups.push(cleanup);
  },
}));

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  react.cleanups.length = 0;
});

describe('useScreenReaderEnabled', () => {
  it('starts at false and takes the answer from the platform’s AccessibilityInfo', async () => {
    expect(useScreenReaderEnabled()).toBe(false);
    await settle();
    expect(platform.isScreenReaderEnabled).toHaveBeenCalledOnce();
    expect(platform.addEventListener).toHaveBeenCalledWith('screenReaderChanged', expect.any(Function));
    expect(react.setState).toHaveBeenCalledWith(true);
  });

  it('unsubscribes when the component goes away', () => {
    useScreenReaderEnabled();
    const subscription = platform.addEventListener.mock.results[0]?.value as { remove: () => void };
    react.cleanups.forEach((cleanup) => cleanup());
    expect(subscription.remove).toHaveBeenCalledOnce();
  });
});

describe('useReduceMotionEnabled', () => {
  it('asks for reduced motion, not the screen reader', async () => {
    expect(useReduceMotionEnabled()).toBe(false);
    await settle();
    expect(platform.isReduceMotionEnabled).toHaveBeenCalledOnce();
    expect(platform.isScreenReaderEnabled).not.toHaveBeenCalled();
    expect(platform.addEventListener).toHaveBeenCalledWith('reduceMotionChanged', expect.any(Function));
    expect(react.setState).toHaveBeenCalledWith(true);
  });
});
