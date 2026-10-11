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
import { useTVEventHandler as useRemoteEvents } from 'react-native';
import { toVegaEvent, type RemoteEvent } from './remoteEvents';

export { Animated, BackHandler, Image, Pressable, StyleSheet, Text, View } from 'react-native';
export type { ImageSourcePropType } from 'react-native';

/** A Vega headless component's handle. Nothing on Fire OS is one; the type exists so shared files compile. */
export type IComponentInstance = never;

export function useTVEventHandler(handler: (event: RemoteEvent) => void): void {
  useRemoteEvents((event) => {
    const pressed = toVegaEvent(event);
    if (pressed) handler(pressed);
  });
}
