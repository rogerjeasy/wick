/**
 * The idle screen (packages/contracts/src/mantel.ts): when the home screen
 * has sat untouched for a few minutes, the pictures she has kept fill it,
 * one at a time, until any key is pressed.
 *
 * No words but, small, who the picture is from. No controls. A picture
 * changes with a fade of the design system's 200 ms — nothing longer,
 * nothing faster — and one that cannot be shown is simply not there: this
 * screen has no sentence to say so.
 *
 * It decides nothing. When it is up, which picture, and when it ends are
 * the app's, from the pure rule (idle.ts) and the one-second look
 * (ResidentApp.tsx); it has no timer and listens for no key. What it does
 * do is hold the remote's focus for as long as it is mounted — while her
 * pictures are on screen, and for the moment after, until the key that
 * ended them has come up again. The home screen underneath cannot be
 * focused meanwhile, so that key press starts no film and opens nothing;
 * and on Android, where a key reaches only what is focused, it is how the
 * key is heard at all (FRICTION.md FL-025).
 */
import * as React from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import type { HouseholdLanguage, MantelItem } from '@wick/contracts';
import { fontSize, motion, safe } from '@wick/vega-calm-ui';
import { words } from '../words/words.js';
import { Picture } from './Picture.js';

export interface IdleScreenProps {
  readonly language: HouseholdLanguage;
  /** Her pictures are on screen. False once a key has ended them: then nothing is drawn, and the home screen shows through. */
  readonly visible: boolean;
  /** The picture that is up. */
  readonly item: MantelItem | undefined;
  /** Its address did not answer. */
  readonly onFailed: (photoId: string) => void;
}

export function IdleScreen({ language, visible, item, onFailed }: IdleScreenProps): React.JSX.Element {
  const say = words(language);
  const opacity = React.useRef(new Animated.Value(0)).current;
  const photoId = item?.photoId;

  // Each picture comes up over the motion token's 200 ms. Nothing else here moves.
  React.useEffect(() => {
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: motion.durationMs, useNativeDriver: true }).start();
  }, [photoId, opacity]);

  return (
    <Pressable
      focusable
      hasTVPreferredFocus
      accessibilityLabel={visible && item ? say('photo.pictureLabel', { name: item.fromName }) : undefined}
      style={[styles.screen, visible ? styles.lit : null]}
    >
      {visible && item ? (
        <>
          <Animated.View style={[styles.picture, { opacity }]}>
            <Picture key={item.url} uri={item.url} fromName={item.fromName} language={language} onFailed={() => onFailed(item.photoId)} wordless />
          </Animated.View>
          <View style={styles.from}>
            <Text style={styles.fromText} numberOfLines={1}>
              {say('mantel.from', { name: item.fromName })}
            </Text>
          </View>
        </>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    ...StyleSheet.absoluteFillObject,
  },
  lit: {
    backgroundColor: safe.ground,
  },
  picture: {
    ...StyleSheet.absoluteFillObject,
  },
  // Bottom left, inside the television's safe area, on a solid band so it reads over any picture.
  from: {
    position: 'absolute',
    left: 48,
    bottom: 32,
    backgroundColor: safe.raised,
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 20,
  },
  // "Small" is the floor: nothing on a television is set under 32pt.
  fromText: {
    color: safe.inkDim,
    fontSize: fontSize('body'),
    lineHeight: fontSize('body') * 1.4,
  },
});
