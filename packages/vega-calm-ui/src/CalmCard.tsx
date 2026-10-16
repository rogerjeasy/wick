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
 *
 * It is drawn in the theme it is given (CalmPreferences.tsx): larger text
 * and higher contrast reach it without a prop. At larger text it fits
 * itself to the screen (theme.ts fitCard) — and a card whose words would
 * not be whole at 40pt is drawn at the standard size, children and all.
 */
import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import { assertActionLimit, assertCardFits, assertContrast, assertNoAlarmColour } from './constraints.js';
import { CalmThemeProvider, useCalmTheme } from './CalmPreferences.js';
import { CARD_BUTTON_GAP_DP, CARD_BUTTON_PADDING_DP, CARD_MEDIA_GAP_DP, fitCard, stylesFor, type CalmTheme } from './theme.js';
import { layout } from './tokens.js';

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
  /** How wide and tall `media` is, so the card can work out at larger text what room its words have. */
  readonly mediaSize?: { readonly width: number; readonly height: number } | undefined;
  /** Beneath the headline and detail, inside the text column. */
  readonly children?: React.ReactNode;
  /**
   * The words `children` draws that must be read whole — a notice, or
   * TwoPhaseCard's detail — so that at larger text the card can tell
   * whether they fit. Write them with `CalmText`, which follows the card
   * if it falls back to the standard size.
   */
  readonly childWords?: readonly (string | undefined)[] | undefined;
  /** Lines `children` keeps whether or not its words have come (TwoPhaseCard keeps two). */
  readonly childLines?: number | undefined;
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
  return renderCalmCard(props, useCalmTheme());
}

/**
 * CalmCard in a given theme, as a plain function: what CalmCard draws in
 * the theme it is given. Exported so the tree can be read without a
 * renderer (src/__tests__/CalmCard.test.ts).
 */
export function renderCalmCard(props: CalmCardProps, asked: CalmTheme): React.JSX.Element {
  const { headline, detail, actions, onAction, initialFocusId, media, mediaSize, children, childWords, childLines, compact, detailLines } = props;

  // Throws before anything reaches the screen.
  assertActionLimit(actions.length);

  // At larger text: the size its words are whole at, and the lines its detail is given.
  const fit = fitCard(
    {
      compact,
      detailLines,
      mediaHeightDp: mediaSize?.height,
      mediaWidthDp: mediaSize?.width,
      headline,
      passages: [detail, ...(childWords ?? [])],
      reservedLines: childLines,
      actionLabels: actions.map((action) => action.label),
    },
    asked,
  );
  const theme = fit.theme;
  const styles = stylesFor(makeStyles, theme);

  assertContrast(theme.palette.ink, theme.palette.raised, theme.minContrast);
  assertContrast(theme.palette.inkDim, theme.palette.raised, theme.minContrast);
  // And every button's words against the button itself.
  for (const action of actions) {
    const colours = theme.actionColours(action.kind);
    assertContrast(colours.label, colours.background, theme.minContrast);
  }
  assertNoAlarmColour(theme.palette.accent);
  // How much card there is around the words: as asked, or — at larger text — less, where that is what fits.
  const tight = fit.compactSpacing;
  const smallHeadline = fit.bodyHeadline;
  // And the card itself against the screen, with the lines it was asked to show — at the floor, where every card must fit.
  if (!theme.preferences.largerText) assertCardFits({ compact, detailLines });

  const focusId = initialFocusId ?? actions[0]?.id;
  const ring = theme.ring();

  return (
    <CalmThemeProvider theme={theme}>
      <View style={[styles.card, tight && styles.cardCompact]}>
        <View style={styles.body}>
          {media}
          <View style={[styles.text, tight && styles.textCompact]}>
            <Text style={[styles.headline, smallHeadline && styles.headlineCompact]} accessibilityRole="header">
              {headline}
            </Text>

            {/* No placeholder, no spinner, no "loading…". Absent means absent. */}
            {detail ? (
              <Text style={styles.detail} numberOfLines={fit.detailLines}>
                {detail}
              </Text>
            ) : null}

            {children}
          </View>
        </View>

        <View style={styles.actions}>
          {actions.map((action) => {
            const colours = theme.actionColours(action.kind);
            return (
              <Pressable
                key={action.id}
                onPress={() => onAction(action.id)}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                hasTVPreferredFocus={action.id === focusId}
                style={({ focused }: { focused: boolean }) => [
                  styles.action,
                  { backgroundColor: colours.background },
                  focused ? ring.focused : ring.rest,
                ]}
              >
                <Text style={[styles.actionLabel, { color: colours.label }]}>{action.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </CalmThemeProvider>
  );
}

const makeStyles = (t: CalmTheme) =>
  StyleSheet.create({
    card: {
      backgroundColor: t.palette.raised,
      borderRadius: 16,
      padding: layout.cardPaddingDp,
      gap: layout.sectionGapDp,
      // With higher contrast on, a black card has a white edge, so it stands apart from a black screen.
      borderWidth: t.cardEdgeDp,
      borderColor: t.palette.ink,
    },
    cardCompact: {
      padding: layout.compactPaddingDp,
      gap: layout.compactGapDp,
    },
    body: {
      flexDirection: 'row',
      gap: CARD_MEDIA_GAP_DP,
    },
    textCompact: {
      gap: layout.compactTextGapDp,
    },
    // Body size, but heavier, so it still reads as the first thing on the card.
    headlineCompact: {
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
      fontWeight: '700',
    },
    text: {
      flex: 1,
      gap: layout.textGapDp,
    },
    headline: {
      color: t.palette.ink,
      fontSize: t.fontSize('headline'),
      lineHeight: t.lineHeight('headline'),
    },
    detail: {
      color: t.palette.inkDim,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
    // Wraps rather than running off the edge: three 32pt reply labels are
    // wider than a 960dp screen (observed on the Vega Virtual Device — the third was cut off).
    actions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: CARD_BUTTON_GAP_DP,
    },
    // Focus is a ring, never a colour change alone — colour alone is invisible to
    // a good proportion of the people this product is for. The ring is the
    // theme's (theme.ts `ring`): thicker with higher contrast on, where every
    // button is outlined at rest as well.
    //
    // The ring appears immediately. `motion.durationMs` governs card entry, which
    // is an Animated timing in TwoPhaseCard — React Native has no CSS transition,
    // so the token cannot be applied here as a style.
    action: {
      paddingVertical: layout.actionPaddingVerticalDp,
      paddingHorizontal: CARD_BUTTON_PADDING_DP,
      borderRadius: 12,
    },
    actionLabel: {
      fontSize: t.fontSize('body'),
    },
  });
