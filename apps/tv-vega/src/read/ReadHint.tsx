/**
 * The mark of the Play key on a card: Play reads it aloud (packages/
 * contracts/src/speech.ts). Not a button — a fourth would break "three,
 * never four" — and not a line of words: hintPlace.ts says why, and where
 * it stands.
 *
 * Drawn, not written: a triangle made of a border, so it needs no letter
 * of any font. To someone who cannot see it, the screen reader says the
 * sentence itself, in her language (words/words.ts).
 *
 * Shown only where reading can work (ResidentApp.tsx).
 */
import * as React from 'react';
import { StyleSheet, View } from '@amazon-devices/react-native-kepler';
import type { Card, HouseholdLanguage } from '@wick/contracts';
import { safe } from '@wick/vega-calm-ui';
import { words } from '../words/words.js';
import { HINT_MARK, hintPlace } from './hintPlace.js';

export interface ReadHintProps {
  readonly cardType: Card['type'];
  readonly language: HouseholdLanguage;
}

export function ReadHint({ cardType, language }: ReadHintProps): React.JSX.Element {
  const place = hintPlace(cardType);
  return (
    <View
      style={[styles.hint, { right: place.right, bottom: place.bottom }]}
      pointerEvents="none"
      accessible
      accessibilityRole="image"
      accessibilityLabel={words(language)('read.hint')}
    >
      <View style={styles.mark} />
    </View>
  );
}

const styles = StyleSheet.create({
  hint: {
    position: 'absolute',
    width: HINT_MARK.width,
    height: HINT_MARK.height,
  },
  // A triangle pointing right: no width or height of its own, only borders.
  mark: {
    width: 0,
    height: 0,
    borderTopWidth: HINT_MARK.height / 2,
    borderBottomWidth: HINT_MARK.height / 2,
    borderLeftWidth: HINT_MARK.width,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: safe.ink,
  },
});
