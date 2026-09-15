/**
 * TwoPhaseCard — render what you have now, patch in the slow part later.
 *
 * Built for the case where a vision model might take two seconds and might never
 * answer. Phase 1 shows immediately; a later patch fills in the detail without
 * re-mounting or moving anything the viewer is already reading.
 *
 * The no-reflow rule is the whole point. Text that shifts under someone mid-read
 * is worse than text that arrives late, and for a reader who is slow by
 * definition it is much worse. So the detail area is reserved at mount and
 * fades its content in; the headline and the buttons never move.
 */
import * as React from 'react';
import { Animated, StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import { CalmCard, type CalmCardProps } from './CalmCard.js';
import { fontSize, safe } from './constraints.js';
import { motion } from './tokens.js';

export interface TwoPhaseCardProps extends Omit<CalmCardProps, 'detail'> {
  /**
   * Phase 2. Undefined means "nothing has arrived, and possibly never will" —
   * which is a supported end state, not a loading condition.
   */
  readonly detail?: string | undefined;
  /** Phase 2a, independent of the text. */
  readonly media?: React.ReactNode;
}

/** Two lines of reserved space, so arriving text displaces nothing. */
const RESERVED_DETAIL_HEIGHT = fontSize('body') * 1.4 * 2;

export function TwoPhaseCard(props: TwoPhaseCardProps): React.JSX.Element {
  const { detail, media, children, ...rest } = props;
  const opacity = React.useRef(new Animated.Value(detail ? 1 : 0)).current;

  React.useEffect(() => {
    if (!detail) return;
    Animated.timing(opacity, {
      toValue: 1,
      duration: motion.durationMs,
      useNativeDriver: true,
    }).start();
  }, [detail, opacity]);

  return (
    <CalmCard {...rest}>
      {media}
      {children}
      {/* Reserved whether or not Phase 2 ever lands. Nothing below this moves. */}
      <View style={styles.detailSlot}>
        <Animated.View style={{ opacity }}>
          {detail ? <Text style={styles.detail}>{detail}</Text> : null}
        </Animated.View>
      </View>
    </CalmCard>
  );
}

const styles = StyleSheet.create({
  detailSlot: {
    minHeight: RESERVED_DETAIL_HEIGHT,
    justifyContent: 'flex-start',
  },
  detail: {
    color: safe.inkDim,
    fontSize: fontSize('body'),
    lineHeight: fontSize('body') * 1.4,
  },
});
