/**
 * Stands in for `@amazon-devices/react-native-kepler` on Fire OS.
 *
 * The Vega app takes its components from Amazon's package; they have the
 * names and props React Native's own have, so on Fire OS they are React
 * Native's own (react-native-tvos, which adds the D-pad focus engine). Only
 * the names the app uses are here — a new one fails
 * `src/__tests__/parity.test.ts` before it fails on a television.
 *
 * The one difference is the remote: Android names its media keys
 * differently, so key presses are renamed on the way in (remoteEvents.ts).
 */
import * as React from 'react';
import { useTVEventHandler as useRemoteEvents } from 'react-native';
import { remoteKeyEvents, type RemoteEvent } from './remoteEvents';

export { Animated, BackHandler, Image, Pressable, StyleSheet, Text, View } from 'react-native';
export type { ImageSourcePropType } from 'react-native';

/** A Vega headless component's handle. Nothing on Fire OS is one; the type exists so shared files compile. */
export type IComponentInstance = never;

export function useTVEventHandler(handler: (event: RemoteEvent) => void): void {
  // Which keys are down, kept across renders: a press is acted on once.
  const toKeys = React.useRef(remoteKeyEvents()).current;
  // The listener is registered once and reads the newest handler from here.
  // The screens hand over a new function on every render, and re-registering
  // each time would leave a gap in which a key press is heard by nobody.
  const latest = React.useRef(handler);
  latest.current = handler;
  const listener = React.useCallback(
    (event: Parameters<Parameters<typeof useRemoteEvents>[0]>[0]) => {
      for (const key of toKeys(event)) latest.current(key);
    },
    [toKeys],
  );
  useRemoteEvents(listener);
}
