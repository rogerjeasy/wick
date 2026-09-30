/**
 * CalmCard — the base surface.
 *
 * Enforced, not suggested: >=32pt type, >=7:1 contrast, <=3 actions, no
 * auto-dismiss, no timer, no red, no badge, no sound.
 *
 * The enforcement is in constraints.ts and runs at render. A card that breaks
 * the floor throws rather than quietly shipping a 24pt label to a television
 * eight feet from someone with cataracts.
 */
import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import {
  assertActionLimit,
  assertContrast,
  assertNoAlarmColour,
  fontSize,
  safe,
} from './constraints.js';

export interface CalmAction {
  readonly id: string;
  readonly label: string;
  readonly kind: 'primary' | 'secondary' | 'dismiss';
}

export interface CalmCardProps {
  readonly headline: string;
  /** Secondary line. Absent until it exists — never a placeholder. */
  readonly detail?: string | undefined;
  readonly actions: readonly CalmAction[];
  readonly onAction: (id: string) => void;
  /** Which action holds focus on mount. Defaults to the first. */
  readonly initialFocusId?: string | undefined;
  /**
   * A photo or camera frame, beside the text on the left — never above the
   * headline. The headline is what a slow reader reads first, and stacking
   * media on top of it also made the card too tall for a 960x540dp screen.
   */
  readonly media?: React.ReactNode;
  /** Beneath the headline and detail, inside the text column. */
  readonly children?: React.ReactNode;
}

export function CalmCard(props: CalmCardProps): React.JSX.Element {
  const { headline, detail, actions, onAction, initialFocusId, media, children } = props;

  // Throws before anything reaches the screen.
  assertActionLimit(actions.length);
  assertContrast(safe.ink, safe.raised);
  assertContrast(safe.inkDim, safe.raised);
  assertNoAlarmColour(safe.accent);

  const focusId = initialFocusId ?? actions[0]?.id;

  return (
    <View style={styles.card}>
      <View style={styles.body}>
        {media}
        <View style={styles.text}>
          <Text style={styles.headline} accessibilityRole="header">
            {headline}
          </Text>

          {/* No placeholder, no spinner, no "loading…". Absent means absent. */}
          {detail ? <Text style={styles.detail}>{detail}</Text> : null}

          {children}
        </View>
      </View>

      <View style={styles.actions}>
        {actions.map((action) => (
          <Pressable
            key={action.id}
            onPress={() => onAction(action.id)}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            hasTVPreferredFocus={action.id === focusId}
            style={({ focused }: { focused: boolean }) => [
              styles.action,
              action.kind === 'primary' && styles.actionPrimary,
              focused && styles.actionFocused,
            ]}
          >
            <Text style={styles.actionLabel}>{action.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: safe.raised,
    borderRadius: 16,
    padding: 32,
    gap: 20,
  },
  body: {
    flexDirection: 'row',
    gap: 24,
  },
  text: {
    flex: 1,
    gap: 12,
  },
  headline: {
    color: safe.ink,
    fontSize: fontSize('headline'),
    lineHeight: fontSize('headline') * 1.25,
  },
  detail: {
    color: safe.inkDim,
    fontSize: fontSize('body'),
    lineHeight: fontSize('body') * 1.4,
  },
  // Wraps rather than running off the edge: three 32pt reply labels are
  // wider than a 960dp screen (observed on the VVD — the third was cut off).
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  action: {
    paddingVertical: 20,
    paddingHorizontal: 32,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: safe.ground,
  },
  actionPrimary: {
    backgroundColor: safe.accent,
  },
  // Focus is a ring, never a colour change alone — colour alone is invisible to
  // a good proportion of the people this product is for.
  //
  // The ring appears immediately. `motion.durationMs` governs card entry, which
  // is an Animated timing in TwoPhaseCard — React Native has no CSS transition,
  // so the token cannot be applied here as a style.
  actionFocused: {
    borderColor: safe.focus,
  },
  actionLabel: {
    color: safe.ink,
    fontSize: fontSize('body'),
  },
});
