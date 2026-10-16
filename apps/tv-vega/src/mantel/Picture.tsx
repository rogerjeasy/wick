/**
 * One picture from the family, shown whole (packages/contracts/src/mantel.ts)
 * — on its card, on the mantelpiece and on the idle screen.
 *
 * Whole: fitted inside its box on the ground colour, never cropped to fill
 * it. It is somebody's face.
 *
 * And never a broken frame. A picture's address is minted for this
 * television and lives an hour, so one that was good may stop answering.
 * Then — or when there is no address at all — the box says so in one calm
 * sentence from the television's own words (words/words.ts), or says
 * nothing where the screen has no words (the idle screen), and whoever drew
 * it is told, so the address can be asked for again.
 */
import * as React from 'react';
import { Image, StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import type { HouseholdLanguage } from '@wick/contracts';
import { useCalmStyles, type CalmTheme } from '@wick/vega-calm-ui';
import { words } from '../words/words.js';

export interface PictureProps {
  /** An https address, or nothing: then the calm line is shown in its place. */
  readonly uri: string | undefined;
  /** Whose picture it is, for the screen reader: the first name of who sent it. */
  readonly fromName: string;
  readonly language: HouseholdLanguage;
  /** The address did not answer. Told once for each address. */
  readonly onFailed?: (() => void) | undefined;
  /** No sentence in the picture's place when it cannot be shown: the idle screen has no words. */
  readonly wordless?: boolean | undefined;
}

export function Picture({ uri, fromName, language, onFailed, wordless }: PictureProps): React.JSX.Element {
  const say = words(language);
  const styles = useCalmStyles(makeStyles);
  // Which address failed, not just that one did: a new address is a new try.
  const [failed, setFailed] = React.useState<string | undefined>(undefined);
  const shown = uri !== undefined && failed !== uri;

  return (
    <View style={styles.box}>
      {shown ? (
        <Image
          source={{ uri }}
          style={styles.picture}
          resizeMode="contain"
          accessibilityLabel={say('photo.pictureLabel', { name: fromName })}
          onError={() => {
            setFailed(uri);
            onFailed?.();
          }}
        />
      ) : wordless ? null : (
        <Text style={styles.line} accessibilityLiveRegion="polite">
          {say('photo.unavailable')}
        </Text>
      )}
    </View>
  );
}

const makeStyles = (t: CalmTheme) =>
  StyleSheet.create({
    // Fills whatever box it is put in; what is not picture is the ground.
    box: {
      flex: 1,
      alignSelf: 'stretch',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.palette.ground,
      borderRadius: 12,
      overflow: 'hidden',
    },
    picture: {
      width: '100%',
      height: '100%',
    },
    line: {
      color: t.palette.inkDim,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
      textAlign: 'center',
      paddingHorizontal: 16,
    },
  });
