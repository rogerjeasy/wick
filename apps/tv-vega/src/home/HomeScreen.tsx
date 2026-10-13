/**
 * The home screen — what would you like to watch?
 *
 * The same floor as every card (docs/WICK.md Part 5): 32pt and up, 7:1
 * contrast, D-pad and OK only, three choices at most, no red, nothing that
 * moves on its own. Focus is a ring, never colour alone.
 *
 * While a card is on screen the tiles give up focus, so the D-pad cannot
 * wander off the card's buttons onto something behind it.
 *
 * OK held for two seconds on anything here is not a press: it brings the
 * card that offers to ask someone to ring her (packages/contracts/src/
 * reach.ts). The platform's own long press tells the two apart, so the film
 * under her thumb does not start when she lets go.
 */
import * as React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import { fontSize, safe } from '@wick/vega-calm-ui';
import type { Programme } from '../catalog/catalog.js';
import { HOLD_MS } from '../watch/hold.js';
import { POSTERS } from './posters.js';

export interface HomeScreenProps {
  readonly programmes: readonly Programme[];
  readonly onChoose: (programme: Programme) => void;
  /** A card is on screen: it owns the remote. */
  readonly cardVisible: boolean;
  /** The programme to return focus to after watching it. */
  readonly lastWatchedId?: string | undefined;
  /**
   * One line about a card that has had its two showings and is waiting to
   * be asked for (home/waiting.ts). Absent when nothing is.
   */
  readonly waiting?: string | undefined;
  readonly onOpenWaiting?: (() => void) | undefined;
  /**
   * How her light in the window stands, in two words (home/light.ts) — the
   * one button beside the question. OK opens the card that says who can
   * see it and lets her put it out. Absent when nobody can see a light.
   */
  readonly light?: string | undefined;
  readonly onOpenLight?: (() => void) | undefined;
  /** "Sarah looked in this morning." Shown where the waiting line goes, when nothing is waiting. */
  readonly lookedIn?: string | undefined;
  /** OK was held for two seconds on whatever has the focus (watch/hold.ts HOLD_MS). */
  readonly onHold?: (() => void) | undefined;
}

export function HomeScreen({ programmes, onChoose, cardVisible, lastWatchedId, waiting, onOpenWaiting, light, onOpenLight, lookedIn, onHold }: HomeScreenProps): React.JSX.Element {
  const focusId = lastWatchedId ?? programmes[0]?.id;
  // One quiet row under the films, and a card waiting to be opened comes first.
  const quiet = waiting ? undefined : lookedIn;

  return (
    <View style={styles.screen}>
      <View style={styles.top}>
        <Text style={[styles.question, styles.questionText]} accessibilityRole="header" numberOfLines={1}>
          What would you like to watch?
        </Text>
        {/* Never focused on its own: the films are what the screen is for. */}
        {light ? (
          <Pressable
            onPress={onOpenLight}
            onLongPress={onHold}
            delayLongPress={HOLD_MS}
            focusable={!cardVisible}
            accessibilityRole="button"
            accessibilityLabel={`Your light in the window. ${light}. Press OK to see who can see it.`}
            style={({ focused }: { focused: boolean }) => [styles.light, focused && styles.tileFocused]}
          >
            <Text style={styles.line} numberOfLines={1}>
              {light}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.row}>
        {programmes.map((programme) => (
          <Pressable
            key={programme.id}
            onPress={() => onChoose(programme)}
            onLongPress={onHold}
            delayLongPress={HOLD_MS}
            focusable={!cardVisible}
            hasTVPreferredFocus={!cardVisible && programme.id === focusId}
            accessibilityRole="button"
            accessibilityLabel={`${programme.title}. ${programme.line}`}
            style={({ focused }: { focused: boolean }) => [styles.tile, focused && styles.tileFocused]}
          >
            <Image source={POSTERS[programme.id]} style={[styles.poster, waiting || quiet ? styles.posterWithRow : null]} resizeMode="cover" accessibilityLabel="" />
            <View style={styles.caption}>
              <Text style={styles.title} numberOfLines={1}>
                {programme.title}
              </Text>
              <Text style={styles.line} numberOfLines={1}>
                {programme.line}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>

      {/* Quiet, and never focused on its own: it is there to be found, not to ask again. */}
      {waiting ? (
        <Pressable
          onPress={onOpenWaiting}
          onLongPress={onHold}
          delayLongPress={HOLD_MS}
          focusable={!cardVisible}
          accessibilityRole="button"
          accessibilityLabel={`${waiting} Press OK to open it.`}
          style={({ focused }: { focused: boolean }) => [styles.waiting, focused && styles.tileFocused]}
        >
          {/* The line gets the width; "Open" says what OK does, and is never what is cut. */}
          <Text style={[styles.line, styles.waitingLine]} numberOfLines={1}>
            {waiting}
          </Text>
          <Text style={styles.title}>Open</Text>
        </Pressable>
      ) : null}

      {/* Who looked in: something to read, with nothing to press. */}
      {quiet ? (
        <View style={styles.waiting} accessibilityRole="text">
          <Text style={[styles.line, styles.waitingLine]} numberOfLines={1}>
            {quiet}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // 960x540dp at 1080p; 48dp/32dp keeps everything inside the TV safe area.
  screen: {
    flex: 1,
    backgroundColor: safe.ground,
    paddingHorizontal: 48,
    paddingVertical: 32,
    gap: 24,
  },
  // The question, and beside it the light: one line, so the films keep their height.
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
  },
  question: {
    color: safe.ink,
    fontSize: fontSize('headline'),
    lineHeight: fontSize('headline') * 1.25,
  },
  questionText: {
    flex: 1,
  },
  light: {
    borderRadius: 16,
    borderWidth: 4,
    borderColor: 'transparent',
    backgroundColor: safe.raised,
    paddingHorizontal: 16,
    paddingVertical: 2,
  },
  row: {
    flexDirection: 'row',
    gap: 24,
  },
  tile: {
    flex: 1,
    borderRadius: 16,
    borderWidth: 4,
    borderColor: 'transparent',
    backgroundColor: safe.raised,
    overflow: 'hidden',
  },
  tileFocused: {
    borderColor: safe.focus,
  },
  // A fixed height, not an aspect ratio: on the VVD `aspectRatio` with a
  // percentage width came out nearly square and pushed the caption off the
  // 540dp screen.
  poster: {
    width: '100%',
    height: 200,
  },
  // Thirty dp less, which is what the waiting row below needs to stay inside 540dp.
  posterWithRow: {
    height: 170,
  },
  waiting: {
    borderRadius: 16,
    borderWidth: 4,
    borderColor: 'transparent',
    backgroundColor: safe.raised,
    paddingHorizontal: 20,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
  },
  waitingLine: {
    flex: 1,
  },
  caption: {
    padding: 16,
    gap: 4,
  },
  title: {
    color: safe.ink,
    fontSize: fontSize('body'),
    lineHeight: fontSize('body') * 1.4,
  },
  line: {
    color: safe.inkDim,
    fontSize: fontSize('body'),
    lineHeight: fontSize('body') * 1.4,
  },
});
