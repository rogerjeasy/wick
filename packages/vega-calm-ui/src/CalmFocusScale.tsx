/**
 * CalmFocusScale — a tile taking the focus grows a little
 * (docs/design/DESIGN.md §4): scale 1 to 1.04 in 150ms, on the design
 * system's curve, and back as the focus leaves. For tiles only, never words
 * alone, and never instead of the focus ring: colour or size alone never
 * shows the focus. With reduced motion asked for it is drawn at its size
 * at once.
 */
import * as React from 'react';
import { Animated, type StyleProp, type ViewStyle } from '@amazon-devices/react-native-kepler';
import { useReduceMotionEnabled } from './accessibility.js';
import { calmEasing } from './CalmPresence.js';
import { motionTimings } from './theme.js';

export interface CalmFocusScaleProps {
  readonly focused: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly children?: React.ReactNode;
}

export function CalmFocusScale({ focused, style, children }: CalmFocusScaleProps): React.JSX.Element {
  const timings = motionTimings(useReduceMotionEnabled());
  const scale = React.useRef(new Animated.Value(focused ? timings.focusScale : 1)).current;
  React.useEffect(() => {
    const animation = Animated.timing(scale, { toValue: focused ? timings.focusScale : 1, duration: timings.focusMs, easing: calmEasing(), useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [focused, scale, timings.focusMs, timings.focusScale]);
  return <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>;
}
