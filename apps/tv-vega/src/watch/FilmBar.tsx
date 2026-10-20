/**
 * The film's bar (docs/design/DESIGN.md §6, watch/transport.ts): what she
 * sees when she asks where the film is — the title, the time gone of the
 * whole, how long is left, and a progress line.
 *
 * WatchScreen.tsx says when it is on screen (transportShown): on a pause,
 * a skip, ↑ or ↓, for four seconds of play after the last of them, and for
 * as long as the film is paused. It fades in and out (CalmPresence), and
 * not at all with reduced motion asked for.
 *
 * It is read, never pressed: nothing in it takes the focus. To the screen
 * reader it is one sentence, the same as the screen says.
 */
import * as React from 'react';
import { StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import type { HouseholdLanguage } from '@wick/contracts';
import { CalmPresence, CalmProgress, useCalmStyles, type CalmTheme } from '@wick/vega-calm-ui';
import { Icon } from '../icons/Icon.js';
import { words } from '../words/words.js';
import { clock, fraction, minutesLeft } from './transport.js';

export interface FilmBarProps {
  readonly shown: boolean;
  readonly language: HouseholdLanguage;
  /** A film's title is its name, and is never translated. */
  readonly title: string;
  readonly positionMs: number;
  readonly durationMs: number;
  readonly paused: boolean;
  /** Who is watching along from their own home, when someone is (packages/contracts watch.ts). */
  readonly companion?: string | undefined;
  /** The film's licence line: said while it is paused, as it always was. */
  readonly attribution?: string | undefined;
}

/** Where the bar sits: inside the television's safe area, at the bottom. */
export const FILM_BAR_PLACE = { left: 48, right: 48, bottom: 32 } as const;

export function FilmBar({ shown, language, title, positionMs, durationMs, paused, companion, attribution }: FilmBarProps): React.JSX.Element {
  const styles = useCalmStyles(makeStyles);
  const say = words(language);
  const elapsed = clock(positionMs);
  const total = clock(durationMs);
  const minutes = minutesLeft(positionMs, durationMs);
  // Paused, the sentence starts with that, in place of the title alone.
  const where = paused ? `${say('watch.paused', { title })}. ${say('watch.time', { elapsed, total })}. ${say('watch.left', { minutes })}.` : say('watch.barLabel', { title, elapsed, total, minutes });
  const label = companion ? `${where} ${say('watch.companion', { name: companion })}` : where;
  return (
    <CalmPresence shown={shown} style={styles.place} pointerEvents="none">
      <View style={styles.bar} accessible accessibilityLabel={label} accessibilityLiveRegion="polite">
        <View style={styles.row}>
          <Icon name={paused ? 'pause' : 'play'} />
          <Text style={[styles.title, styles.grow]}>{title}</Text>
          <Text style={styles.quiet}>{say('watch.left', { minutes })}</Text>
        </View>
        <CalmProgress fraction={fraction(positionMs, durationMs)} />
        <View style={styles.row}>
          <Text style={[styles.time, styles.grow]}>{say('watch.time', { elapsed, total })}</Text>
        </View>
        {companion ? <Text style={styles.title}>{say('watch.companion', { name: companion })}</Text> : null}
        {paused && attribution ? <Text style={styles.quiet}>{attribution}</Text> : null}
      </View>
    </CalmPresence>
  );
}

const makeStyles = (t: CalmTheme) =>
  StyleSheet.create({
    place: {
      position: 'absolute',
      ...FILM_BAR_PLACE,
    },
    // The focused surface: a step up from a card, so it reads as "now", over any frame of the film.
    bar: {
      backgroundColor: t.palette.raisedHigh,
      borderRadius: 16,
      borderWidth: t.cardEdgeDp,
      borderColor: t.palette.ink,
      paddingVertical: 16,
      paddingHorizontal: 24,
      gap: 12,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
    },
    grow: {
      flex: 1,
    },
    title: {
      color: t.palette.ink,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
      fontWeight: '700',
    },
    time: {
      color: t.palette.ink,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
    quiet: {
      color: t.palette.inkDim,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
  });
