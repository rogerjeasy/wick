/**
 * How Wick works, one step at a time (tour/tour.ts, docs/design/DESIGN.md
 * §6): opened from a pill on the home screen, so that someone holding only
 * the remote — a judge, a son setting it up, Margaret on her first evening
 * — sees what Wick does without anyone at the other end.
 *
 * Each step is an example of one thing, drawn as that thing is drawn and
 * marked "Example": the door, as DoorCard.tsx lays it out, with a bundled
 * sample picture; a note, as MessageCard.tsx; the hold line, as
 * press/HoldLine.tsx; the read mark, as cards carry it. Under it, why, in a
 * sentence or two; then "Show me the next" and "Close the tour".
 *
 * Nothing in it is sent, asked, read from the server or kept: it is words,
 * a picture and the app's own presses (ResidentApp.tsx). OK presses the
 * button with the focus, Back closes the tour, and Play does nothing here:
 * the app's reader reads a card the server has, and these are not.
 *
 * Every word is at the floor; a step that would not fit whole at larger
 * text is drawn at the standard size (tour/tourLayout.ts tourTheme).
 */
import * as React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import type { HouseholdLanguage } from '@wick/contracts';
import { CalmPresence, CalmProgress, CalmThemeProvider, stylesFor, useCalmTheme, type CalmTheme } from '@wick/vega-calm-ui';
import { Icon } from '../icons/Icon.js';
import { words, type PlainWordKey } from '../words/words.js';
import { TOUR_STEPS, stepWords, tourActions } from './tour.js';
import { BAR_PADDING, TAG_PADDING, TOUR_FRAME, TOUR_GAP_DP, TOUR_SCREEN, TOUR_TEXT_GAP_DP, exampleIsCard, tagHeightDp, tourTheme } from './tourLayout.js';
import { TOUR_DOOR_PICTURE } from './tourPicture.js';

export interface TourScreenProps {
  /** The step on screen (tour.ts TourState). */
  readonly index: number;
  readonly language: HouseholdLanguage;
  /** The first person in her circle, when the television knows; otherwise "your family" (tour.family). */
  readonly name?: string | undefined;
  readonly onAction: (id: 'next' | 'close') => void;
}

/** How far the hold line in the example has filled: part way, as a hold is seen half done. */
const HOLD_EXAMPLE_FILL = 0.6;

export function TourScreen({ index, language, name, onAction }: TourScreenProps): React.JSX.Element | null {
  const asked = useCalmTheme();
  const step = TOUR_STEPS[index];
  if (!step) return null;
  const say = words(language);
  const who = name ?? say('tour.family');
  const w = stepWords(say, step, who);
  // Whole at the size she chose, or at the standard size.
  const theme = tourTheme(asked, step.kind, w);
  const styles = stylesFor(makeStyles, theme);
  const actions = tourActions(index);
  const kicker = say('tour.kicker', { step: index + 1, count: TOUR_STEPS.length });

  const example = ((): React.JSX.Element | null => {
    switch (step.kind) {
      case 'door':
        return (
          <View style={[styles.card, styles.cardCompact, styles.row]}>
            <Image source={TOUR_DOOR_PICTURE} style={styles.frame} resizeMode="cover" accessibilityLabel={say('tour.doorPicture')} />
            <View style={[styles.grow, styles.compactText]}>
              <Text style={styles.cardHeadlineCompact}>{w.headline}</Text>
              <Text style={styles.dim}>{w.example}</Text>
            </View>
          </View>
        );
      case 'note':
        return (
          <View style={[styles.card, styles.text]}>
            <Text style={styles.cardHeadline}>{w.headline}</Text>
            <Text style={styles.dim}>{w.example}</Text>
          </View>
        );
      case 'hold':
        return (
          <View style={[styles.bar, styles.barGap]}>
            <View style={styles.iconRow}>
              <Icon name="hold" />
              <Text style={[styles.ink, styles.grow]}>{say('hold.keep', { name: who })}</Text>
            </View>
            <CalmProgress fraction={HOLD_EXAMPLE_FILL} />
          </View>
        );
      case 'read':
        return (
          <View style={[styles.bar, styles.iconRow]}>
            <Icon name="read" />
            <Text style={styles.ink}>{say('read.chip')}</Text>
          </View>
        );
      default:
        return null;
    }
  })();

  return (
    <CalmThemeProvider theme={theme}>
      <CalmPresence shown rises style={styles.screen}>
        {example ? (
          <View style={styles.exampleWrap} accessible accessibilityLabel={`${kicker}. ${say('tour.example')}. ${exampleIsCard(step.kind) ? `${w.headline} ${w.example ?? ''}` : ''}`.trim()}>
            {example}
            {/* Two tags on its top edge: where in the tour this is, and that it is only an example. */}
            <View style={styles.tags} pointerEvents="none">
              <View style={[styles.tag, styles.tagKicker]}>
                <Text style={styles.tagKickerText}>{kicker}</Text>
              </View>
              <View style={[styles.tag, styles.tagExample]}>
                <Text style={styles.tagExampleText}>{say('tour.example')}</Text>
              </View>
            </View>
          </View>
        ) : (
          <Text style={styles.kicker}>{kicker}</Text>
        )}
        {exampleIsCard(step.kind) ? null : (
          <Text style={styles.headline} accessibilityRole="header">
            {w.headline}
          </Text>
        )}
        <Text style={styles.detail}>{w.detail}</Text>
        <View style={styles.buttons}>
          {actions.map((action, at) => {
            const colours = theme.actionColours(action.kind);
            const ring = theme.ring();
            const label = say(action.labelKey as PlainWordKey);
            return (
              <Pressable
                key={`${index}:${action.id}`}
                onPress={() => onAction(action.id)}
                accessibilityRole="button"
                accessibilityLabel={label}
                hasTVPreferredFocus={at === 0}
                style={({ focused }: { focused: boolean }) => [styles.button, { backgroundColor: colours.background }, focused ? ring.focused : ring.rest]}
              >
                <Text style={[styles.buttonText, { color: colours.label }]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      </CalmPresence>
    </CalmThemeProvider>
  );
}

const makeStyles = (t: CalmTheme) =>
  StyleSheet.create({
    // The whole screen, the home's ground: the tour has the remote, and nothing of the home shows behind it.
    screen: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      backgroundColor: t.palette.ground,
      paddingHorizontal: TOUR_SCREEN.paddingHorizontal,
      paddingVertical: TOUR_SCREEN.paddingVertical,
      justifyContent: 'flex-end',
      gap: TOUR_GAP_DP,
    },
    exampleWrap: {
      marginTop: tagHeightDp(t) / 2,
    },
    tags: {
      position: 'absolute',
      top: -tagHeightDp(t) / 2,
      left: 16,
      right: 16,
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    tag: {
      borderRadius: 12,
      paddingHorizontal: TAG_PADDING.horizontal,
      paddingVertical: TAG_PADDING.vertical,
      borderWidth: t.cardEdgeDp,
      borderColor: t.palette.ink,
    },
    tagKicker: {
      backgroundColor: t.palette.raisedHigh,
    },
    tagKickerText: {
      color: t.palette.inkDim,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
    // "Example", in the amber of a first button: it must be seen.
    tagExample: {
      backgroundColor: t.palette.accent,
    },
    tagExampleText: {
      color: t.palette.ground,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
      fontWeight: '700',
    },
    // A card's face, as CalmCard draws it.
    card: {
      backgroundColor: t.palette.raised,
      borderRadius: 16,
      padding: 32,
      borderWidth: t.cardEdgeDp,
      borderColor: t.palette.ink,
    },
    cardCompact: {
      padding: 24,
    },
    row: {
      flexDirection: 'row',
      gap: 24,
    },
    text: {
      gap: 12,
    },
    compactText: {
      gap: 4,
    },
    grow: {
      flex: 1,
    },
    frame: {
      ...TOUR_FRAME,
      borderRadius: 12,
      backgroundColor: t.palette.ground,
    },
    cardHeadline: {
      color: t.palette.ink,
      fontSize: t.fontSize('headline'),
      lineHeight: t.lineHeight('headline'),
    },
    cardHeadlineCompact: {
      color: t.palette.ink,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
      fontWeight: '700',
    },
    // A bar, as the hold line and the film's bar are drawn.
    bar: {
      backgroundColor: t.palette.raisedHigh,
      borderRadius: 16,
      paddingVertical: BAR_PADDING.vertical,
      paddingHorizontal: BAR_PADDING.horizontal,
      borderWidth: t.cardEdgeDp,
      borderColor: t.palette.ink,
    },
    barGap: {
      gap: 12,
    },
    iconRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
    },
    ink: {
      color: t.palette.ink,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
    dim: {
      color: t.palette.inkDim,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
    kicker: {
      color: t.palette.inkDim,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
      marginBottom: TOUR_TEXT_GAP_DP - TOUR_GAP_DP,
    },
    headline: {
      color: t.palette.ink,
      fontSize: t.fontSize('headline'),
      lineHeight: t.lineHeight('headline'),
      marginBottom: TOUR_TEXT_GAP_DP - TOUR_GAP_DP,
    },
    detail: {
      color: t.palette.ink,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
    buttons: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 16,
    },
    button: {
      paddingVertical: 20,
      paddingHorizontal: 32,
      borderRadius: 12,
    },
    buttonText: {
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
  });
