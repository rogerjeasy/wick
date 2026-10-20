/**
 * CalmProgress — a progress line: an amber fill on its track
 * (docs/design/DESIGN.md §2). How far a film has got, how long OK has been
 * held, how much of a film she left is behind her.
 *
 * Drawn, never written: it says nothing to the screen reader, so whatever
 * shows it says the same in words (a time, "6 min left", "Keep holding").
 * With higher contrast on the track is black with a white edge and the
 * fill is white: still black and white, still seen.
 *
 * `fraction` draws it where it is; `animated` (0 to 1) lets a caller move
 * it — the hold line fills over the hold, and the fill is the hold itself.
 */
import * as React from 'react';
import { Animated, StyleSheet, View } from '@amazon-devices/react-native-kepler';
import { useCalmStyles } from './CalmPreferences.js';
import type { CalmTheme } from './theme.js';

export interface CalmProgressProps {
  /** From 0 to 1. Outside that, the nearest end. */
  readonly fraction?: number | undefined;
  /** From 0 to 1, moved by the caller. Takes the place of `fraction`. */
  readonly animated?: Animated.Value | undefined;
  /** How thick the line is. 8dp: seen from across a room, and still a line. */
  readonly heightDp?: number | undefined;
}

export const PROGRESS_HEIGHT_DP = 8;

export function CalmProgress({ fraction, animated, heightDp = PROGRESS_HEIGHT_DP }: CalmProgressProps): React.JSX.Element {
  const styles = useCalmStyles(makeStyles);
  const width = animated
    ? animated.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'], extrapolate: 'clamp' })
    : (`${Math.round(Math.min(1, Math.max(0, Number.isFinite(fraction) ? (fraction as number) : 0)) * 1000) / 10}%` as `${number}%`);
  return (
    <View style={[styles.track, { height: heightDp, borderRadius: heightDp / 2 }]} accessible={false} importantForAccessibility="no-hide-descendants">
      <Animated.View style={[styles.fill, { width, borderRadius: heightDp / 2 }]} />
    </View>
  );
}

const makeStyles = (t: CalmTheme) =>
  StyleSheet.create({
    track: {
      width: '100%',
      overflow: 'hidden',
      backgroundColor: t.palette.track,
      borderWidth: t.trackEdgeDp,
      borderColor: t.palette.ink,
    },
    fill: {
      height: '100%',
      backgroundColor: t.palette.accent,
    },
  });
