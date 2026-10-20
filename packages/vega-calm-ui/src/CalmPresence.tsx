/**
 * CalmPresence — something arriving and leaving, calmly
 * (docs/design/DESIGN.md §4).
 *
 * It arrives in `motion.enterMs` (200ms): its opacity from 0 to 1 and, if
 * it `rises`, 12dp up into place. It leaves in `motion.exitMs` (150ms):
 * its opacity back to 0, and only then is it taken off the screen. Both on
 * the design system's curve. Nothing loops and nothing moves by itself: it
 * moves only when `shown` changes. With reduced motion asked for
 * (`useReduceMotionEnabled`), both are an instant change.
 *
 * React Native's own `Animated`: no native module, so the same code runs
 * on Vega and, through the Fire OS adapters, on Fire OS.
 */
import * as React from 'react';
import { Animated, Easing, type StyleProp, type ViewStyle } from '@amazon-devices/react-native-kepler';
import { useReduceMotionEnabled } from './accessibility.js';
import { motionTimings } from './theme.js';
import { motion } from './tokens.js';

export interface CalmPresenceProps {
  /** On the screen, or on its way off it. */
  readonly shown: boolean;
  /** Rise 12dp into place as it arrives (a card), or only fade (a bar that is already where it belongs). */
  readonly rises?: boolean | undefined;
  readonly style?: StyleProp<ViewStyle>;
  readonly pointerEvents?: 'box-none' | 'none' | 'box-only' | 'auto' | undefined;
  readonly children?: React.ReactNode;
}

/** The design system's curve, cubic-bezier(0.2, 0, 0, 1). */
export const calmEasing = (): ((t: number) => number) => Easing.bezier(...motion.easing);

export function CalmPresence({ shown, rises = false, style, pointerEvents, children }: CalmPresenceProps): React.JSX.Element | null {
  const timings = motionTimings(useReduceMotionEnabled());
  const progress = React.useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = React.useState(shown);

  React.useEffect(() => {
    if (shown) setMounted(true);
    const animation = Animated.timing(progress, {
      toValue: shown ? 1 : 0,
      duration: shown ? timings.enterMs : timings.exitMs,
      easing: calmEasing(),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !shown) setMounted(false);
    });
    return () => animation.stop();
  }, [shown, progress, timings.enterMs, timings.exitMs]);

  if (!shown && !mounted) return null;
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [rises ? timings.enterRiseDp : 0, 0] });
  return (
    <Animated.View style={[style, { opacity: progress, transform: [{ translateY }] }]} pointerEvents={pointerEvents}>
      {children}
    </Animated.View>
  );
}
