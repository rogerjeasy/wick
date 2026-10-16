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
 * fades its content in, and with `mediaSize` so is the media box — the
 * picture lands in space that was already there. The headline and the
 * buttons never move.
 *
 * The fade is the package's one animation: 200ms, opacity only.
 * When the platform says the viewer wants reduced motion, there is no fade.
 *
 * The reserved lines are the theme's (CalmPreferences.tsx): two lines at
 * 40pt with larger text on. The detail is measured with the card at larger
 * text (CalmCard `childWords`), and follows it if it falls back.
 */
import * as React from 'react';
import { Animated, StyleSheet, View } from '@amazon-devices/react-native-kepler';
import { useReduceMotionEnabled } from './accessibility.js';
import { CalmCard, type CalmCardProps } from './CalmCard.js';
import { CalmText, useCalmStyles } from './CalmPreferences.js';
import type { CalmTheme } from './theme.js';
import { motion } from './tokens.js';

export interface TwoPhaseCardProps extends Omit<CalmCardProps, 'detail' | 'mediaSize'> {
  /**
   * Phase 2. Undefined means "nothing has arrived, and possibly never will" —
   * which is a supported end state, not a loading condition.
   */
  readonly detail?: string | undefined;
  /** Phase 2a, independent of the text. */
  readonly media?: React.ReactNode;
  /**
   * Reserve the media box at mount, empty until `media` arrives. Without it,
   * a picture patching in shoves the headline sideways mid-read.
   */
  readonly mediaSize?: { readonly width: number; readonly height: number };
}

/** Two lines of reserved space, so arriving text displaces nothing. */
export const RESERVED_DETAIL_LINES = 2;

export function TwoPhaseCard(props: TwoPhaseCardProps): React.JSX.Element {
  const { detail, media, mediaSize, children, childWords, ...rest } = props;
  const opacity = React.useRef(new Animated.Value(detail ? 1 : 0)).current;
  const reduceMotion = useReduceMotionEnabled();

  React.useEffect(() => {
    if (!detail) return;
    // A viewer who asked for less motion gets the words at once.
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    Animated.timing(opacity, {
      toValue: 1,
      duration: motion.durationMs,
      useNativeDriver: true,
    }).start();
  }, [detail, opacity, reduceMotion]);

  return (
    <CalmCard
      {...rest}
      mediaSize={mediaSize}
      childWords={[...(childWords ?? []), detail]}
      childLines={RESERVED_DETAIL_LINES}
      media={mediaSize ? <MediaSlot size={mediaSize}>{media}</MediaSlot> : media}
    >
      {children}
      {/* Reserved whether or not Phase 2 ever lands. Nothing below this moves. */}
      <DetailSlot>
        <Animated.View style={{ opacity }}>{detail ? <CalmText tone="dim">{detail}</CalmText> : null}</Animated.View>
      </DetailSlot>
    </CalmCard>
  );
}

const makeStyles = (t: CalmTheme) =>
  StyleSheet.create({
    mediaSlot: {
      borderRadius: 12,
      overflow: 'hidden',
      backgroundColor: t.palette.ground,
    },
    detailSlot: {
      minHeight: t.lineHeight('body') * RESERVED_DETAIL_LINES,
      justifyContent: 'flex-start',
    },
  });

/** Drawn inside the card, so it is in the card's theme — the standard one if the card fell back. */
function DetailSlot({ children }: { readonly children?: React.ReactNode }): React.JSX.Element {
  const styles = useCalmStyles(makeStyles);
  return <View style={styles.detailSlot}>{children}</View>;
}

function MediaSlot({ size, children }: { readonly size: { readonly width: number; readonly height: number }; readonly children?: React.ReactNode }): React.JSX.Element {
  const styles = useCalmStyles(makeStyles);
  return <View style={[styles.mediaSlot, size]}>{children}</View>;
}
