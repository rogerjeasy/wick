/**
 * The viewer's own accessibility settings, read from the platform.
 *
 * Vega's `AccessibilityInfo` (from @amazon-devices/react-native-kepler) is
 * React Native's, extended for the `kepler` platform: it answers
 * `isScreenReaderEnabled()` and `isReduceMotionEnabled()`, and emits
 * `screenReaderChanged` when VoiceView is turned on or off. Vega does not
 * emit `reduceMotionChanged` (its event table has no entry for it), so on
 * Vega that setting is read once, when the hook mounts; on Android TV and
 * tvOS it is followed live like the screen reader.
 *
 * The logic is `watchAccessibility`, a plain function that takes the
 * `AccessibilityInfo` it should ask, so it is tested without a device. The
 * hooks are a `useEffect` around it.
 */
import * as React from 'react';
import { AccessibilityInfo } from '@amazon-devices/react-native-kepler';

/** The settings these hooks follow. */
export type AccessibilitySetting = 'screenReader' | 'reduceMotion';

/**
 * The part of `AccessibilityInfo` this module uses. Vega's, React Native's
 * and react-native-tvos's all satisfy it.
 */
export interface AccessibilitySource {
  isScreenReaderEnabled(): Promise<boolean>;
  isReduceMotionEnabled(): Promise<boolean>;
  addEventListener(
    eventName: 'screenReaderChanged' | 'reduceMotionChanged',
    handler: (enabled: boolean) => void,
  ): { remove(): void } | undefined;
}

const QUERY: Record<AccessibilitySetting, (source: AccessibilitySource) => Promise<boolean>> = {
  screenReader: (source) => source.isScreenReaderEnabled(),
  reduceMotion: (source) => source.isReduceMotionEnabled(),
};

const EVENT = {
  screenReader: 'screenReaderChanged',
  reduceMotion: 'reduceMotionChanged',
} as const;

/**
 * Asks the platform for a setting once, then follows its changes. Calls
 * `onChange` with each value it learns, and returns a function that stops.
 *
 * - A change event that arrives before the first answer is newer than that
 *   answer, so the answer is then ignored.
 * - A query that fails (a platform that does not support the setting)
 *   reports nothing: the caller keeps its default, which for both settings
 *   is "off". Unknown is never reported as on.
 * - Nothing is reported after the returned function is called, so an answer
 *   that lands after unmount never sets state.
 */
export function watchAccessibility(
  source: AccessibilitySource,
  setting: AccessibilitySetting,
  onChange: (enabled: boolean) => void,
): () => void {
  let live = true;
  let heardChange = false;

  const subscription = source.addEventListener(EVENT[setting], (enabled) => {
    heardChange = true;
    if (live) onChange(enabled === true);
  });

  let query: Promise<boolean>;
  try {
    query = QUERY[setting](source);
  } catch {
    query = Promise.reject(new Error(`${setting} is not supported here`));
  }
  query.then(
    (enabled) => {
      if (live && !heardChange) onChange(enabled === true);
    },
    () => {
      // Not supported on this platform: leave the default in place.
    },
  );

  return () => {
    live = false;
    subscription?.remove();
  };
}

function useAccessibilitySetting(setting: AccessibilitySetting): boolean {
  const [enabled, setEnabled] = React.useState(false);
  React.useEffect(
    () => watchAccessibility(AccessibilityInfo as unknown as AccessibilitySource, setting, setEnabled),
    [setting],
  );
  return enabled;
}

/**
 * Whether a screen reader (VoiceView on Fire TV, TalkBack on Android TV,
 * VoiceOver on tvOS) is on. `false` until the platform has answered.
 *
 * Use it to leave a card on screen until it is dismissed rather than
 * assuming it has been read, and to keep labels free of visual-only cues.
 */
export function useScreenReaderEnabled(): boolean {
  return useAccessibilitySetting('screenReader');
}

/**
 * Whether the viewer has asked for less motion. `false` until the platform
 * has answered. TwoPhaseCard uses it to show arriving detail at once instead
 * of fading it in.
 */
export function useReduceMotionEnabled(): boolean {
  return useAccessibilitySetting('reduceMotion');
}
