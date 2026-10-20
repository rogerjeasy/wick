/**
 * The mark of the Play key on a card: Play reads it aloud (packages/
 * contracts/src/speech.ts). Not a button — a fourth would break "three,
 * never four" — and drawn over the card, not laid out in it (hintPlace.ts).
 *
 * Where the card's buttons leave room at the end of their row, it is a
 * chip: the speaker icon and "Read aloud". Where they do not, it is the
 * icon alone, in the last button's margin. Either way the screen reader
 * says the sentence itself, in her language (words/words.ts).
 *
 * Shown only where reading can work (ResidentApp.tsx).
 */
import * as React from 'react';
import { StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import type { Card, HouseholdLanguage } from '@wick/contracts';
import { useCalmStyles, useCalmTheme, type CalmTheme } from '@wick/vega-calm-ui';
import { Icon } from '../icons/Icon.js';
import { words } from '../words/words.js';
import { iconSizeDp } from '../icons/icons.js';
import { READ_CHIP, readChipFits, readChipHeightDp, readChipPlace } from './hintPlace.js';

export interface ReadHintProps {
  readonly cardType: Card['type'];
  readonly language: HouseholdLanguage;
  /** The words on the card's buttons (hintPlace.ts actionLabelsOf): whether "Read aloud" fits beside them. */
  readonly actionLabels?: readonly string[] | undefined;
}

export function ReadHint({ cardType, language, actionLabels }: ReadHintProps): React.JSX.Element {
  const theme = useCalmTheme();
  const styles = useCalmStyles(makeStyles);
  const say = words(language);
  const chip = say('read.chip');
  const withWords = actionLabels !== undefined && readChipFits(theme, cardType, actionLabels, chip);
  const place = readChipPlace(cardType, theme, withWords ? readChipHeightDp(theme) : iconSizeDp(theme));
  return (
    <View
      style={[styles.hint, withWords ? styles.chip : styles.iconOnly, { right: place.right, bottom: place.bottom }]}
      pointerEvents="none"
      accessible
      accessibilityRole="image"
      accessibilityLabel={say('read.hint')}
    >
      <Icon name="read" />
      {withWords ? <Text style={styles.words}>{chip}</Text> : null}
    </View>
  );
}

const makeStyles = (t: CalmTheme) =>
  StyleSheet.create({
    hint: {
      position: 'absolute',
      flexDirection: 'row',
      alignItems: 'center',
    },
    chip: {
      gap: READ_CHIP.iconGapDp,
      borderRadius: 12,
      paddingHorizontal: READ_CHIP.paddingHorizontal,
      paddingVertical: READ_CHIP.paddingVertical,
      backgroundColor: t.palette.raisedHigh,
      borderWidth: t.cardEdgeDp,
      borderColor: t.palette.ink,
    },
    iconOnly: {},
    words: {
      color: t.palette.ink,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
  });
