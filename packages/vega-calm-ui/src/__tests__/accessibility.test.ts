import { describe, expect, it, vi } from 'vitest';
import { watchAccessibility, type AccessibilitySource } from '../accessibility.js';

vi.mock('@amazon-devices/react-native-kepler', () => ({ AccessibilityInfo: {} }));

/** An AccessibilityInfo whose answers and change events the test controls. */
function fakeSource(answer: () => Promise<boolean>) {
  const handlers = new Map<string, (enabled: boolean) => void>();
  const remove = vi.fn();
  const source: AccessibilitySource = {
    isScreenReaderEnabled: answer,
    isReduceMotionEnabled: answer,
    addEventListener: (name, handler) => {
      handlers.set(name, handler);
      return { remove };
    },
  };
  const emit = (name: string, enabled: boolean): void => handlers.get(name)?.(enabled);
  return { source, emit, remove, handlers };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('watchAccessibility', () => {
  it('reports what the platform answers', async () => {
    const { source } = fakeSource(() => Promise.resolve(true));
    const seen: boolean[] = [];
    watchAccessibility(source, 'screenReader', (v) => seen.push(v));
    await settle();
    expect(seen).toEqual([true]);
  });

  it('follows the setting when it changes', async () => {
    const { source, emit } = fakeSource(() => Promise.resolve(false));
    const seen: boolean[] = [];
    watchAccessibility(source, 'screenReader', (v) => seen.push(v));
    await settle();
    emit('screenReaderChanged', true);
    emit('screenReaderChanged', false);
    expect(seen).toEqual([false, true, false]);
  });

  it('listens for the event that belongs to the setting', () => {
    const { source, handlers } = fakeSource(() => Promise.resolve(false));
    watchAccessibility(source, 'reduceMotion', () => undefined);
    expect([...handlers.keys()]).toEqual(['reduceMotionChanged']);
  });

  it('lets a change that arrives before the first answer stand: it is the newer of the two', async () => {
    let answer: (v: boolean) => void = () => undefined;
    const { source, emit } = fakeSource(() => new Promise((resolve) => (answer = resolve)));
    const seen: boolean[] = [];
    watchAccessibility(source, 'screenReader', (v) => seen.push(v));
    emit('screenReaderChanged', true);
    answer(false);
    await settle();
    expect(seen).toEqual([true]);
  });

  it('reports nothing when the platform cannot say — unknown is never reported as on', async () => {
    const rejects = fakeSource(() => Promise.reject(new Error('not supported')));
    const throws = fakeSource(() => {
      throw new Error('not a function on this platform');
    });
    const seen: boolean[] = [];
    watchAccessibility(rejects.source, 'reduceMotion', (v) => seen.push(v));
    watchAccessibility(throws.source, 'reduceMotion', (v) => seen.push(v));
    await settle();
    expect(seen).toEqual([]);
  });

  it('stops: no report after it is stopped, and the subscription is removed', async () => {
    const { source, emit, remove } = fakeSource(() => Promise.resolve(true));
    const seen: boolean[] = [];
    const stop = watchAccessibility(source, 'screenReader', (v) => seen.push(v));
    stop();
    await settle();
    emit('screenReaderChanged', true);
    expect(seen).toEqual([]);
    expect(remove).toHaveBeenCalledOnce();
  });

  it('copes with a platform whose addEventListener returns nothing', async () => {
    const source: AccessibilitySource = {
      isScreenReaderEnabled: () => Promise.resolve(true),
      isReduceMotionEnabled: () => Promise.resolve(true),
      addEventListener: () => undefined,
    };
    const seen: boolean[] = [];
    const stop = watchAccessibility(source, 'screenReader', (v) => seen.push(v));
    await settle();
    expect(() => stop()).not.toThrow();
    expect(seen).toEqual([true]);
  });
});
