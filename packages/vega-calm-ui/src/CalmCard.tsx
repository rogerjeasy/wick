/**
 * CalmCard — the base surface.
 *
 * Enforced, not suggested: >=32pt type, >=7:1 contrast, <=3 actions, <=5
 * lines of detail (so the buttons are always on screen) — or as many as a
 * card that must be read whole asks for and the screen still has room for
 * (`detailLines`) — no auto-dismiss, no timer, no red, no badge, no sound.
 *
 * The enforcement is in constraints.ts and runs at render. A card that breaks
 * the floor throws rather than quietly shipping a 24pt label to a television
 * eight feet from someone with cataracts.
 */
import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import { assertActionLimit, assertCardFits, assertContrast, assertNoAlarmColour, fontSize, safe, actionColours } from './constraints.js';
import { layout, limits } from './tokens.js';

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
  /**
   * For a card that sits over a programme: tighter spacing, and the headline
   * at body size so it fits on one line. Still at the 32pt floor — compact
   * means less card, never smaller type than the floor allows.
   */
  readonly compact?: boolean | undefined;
  /**
   * How many lines of detail to show, for a card whose detail must be read
   * whole — a question asked in two languages at once. Five when absent.
   * More is allowed only while the card still fits the screen at the 32pt
   * floor (constraints.ts assertCardFits), which in practice means with
   * `compact`: a card that would not fit throws rather than losing its
   * buttons off the bottom.
   */
  readonly detailLines?: number | undefined;
}

export function CalmCard(props: CalmCardProps): React.JSX.Element {
  const { headline, detail, actions, onAction, initialFocusId, media, children, compact, detailLines } = props;

  // Throws before anything reaches the screen.
  assertActionLimit(actions.length);
  assertContrast(safe.ink, safe.raised);
  assertContrast(safe.inkDim, safe.raised);
  // And every button's words against the button itself.
  for (const action of actions) {
    const colours = actionColours(action.kind);
    assertContrast(colours.label, colours.background);
  }
  assertNoAlarmColour(safe.accent);
  // And the card itself against the screen, with the lines it was asked to show.
  assertCardFits({ compact, detailLines });

  const focusId = initialFocusId ?? actions[0]?.id;

  return (
    <View style={[styles.card, compact && styles.cardCompact]}>
      <View style={styles.body}>
        {media}
        <View style={[styles.text, compact && styles.textCompact]}>
          <Text style={[styles.headline, compact && styles.headlineCompact]} accessibilityRole="header">
            {headline}
          </Text>

          {/* No placeholder, no spinner, no "loading…". Absent means absent. */}
          {detail ? (
            <Text style={styles.detail} numberOfLines={detailLines ?? limits.maxDetailLines}>
              {detail}
            </Text>
          ) : null}

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
            <Text style={[styles.actionLabel, { color: actionColours(action.kind).label }]}>{action.label}</Text>
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
    padding: layout.cardPaddingDp,
    gap: layout.sectionGapDp,
  },
  cardCompact: {
    padding: layout.compactPaddingDp,
    gap: layout.compactGapDp,
  },
  body: {
    flexDirection: 'row',
    gap: 24,
  },
  textCompact: {
    gap: layout.compactTextGapDp,
  },
  // Body size, but heavier, so it still reads as the first thing on the card.
  headlineCompact: {
    fontSize: fontSize('body'),
    lineHeight: fontSize('body') * layout.lineHeight.body,
    fontWeight: '700',
  },
  text: {
    flex: 1,
    gap: layout.textGapDp,
  },
  headline: {
    color: safe.ink,
    fontSize: fontSize('headline'),
    lineHeight: fontSize('headline') * layout.lineHeight.headline,
  },
  detail: {
    color: safe.inkDim,
    fontSize: fontSize('body'),
    lineHeight: fontSize('body') * layout.lineHeight.body,
  },
  // Wraps rather than running off the edge: three 32pt reply labels are
  // wider than a 960dp screen (observed on the Vega Virtual Device — the third was cut off).
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  action: {
    paddingVertical: layout.actionPaddingVerticalDp,
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
