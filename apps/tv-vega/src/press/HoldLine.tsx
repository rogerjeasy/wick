/**
 * The hold line (docs/design/DESIGN.md §6, watch/hold.ts holdProgress):
 * holding OK shows itself from 0.4 s, so a press that is becoming a hold
 * can be seen — and let go. A bar at the bottom of the screen says what
 * holding will do, and a line under the words fills, evenly, to the two
 * seconds. Let go before then and it goes, and nothing happens at all.
 *
 * It is told when OK went down (`since`) and draws nothing before
 * HOLD_SHOWN_FROM_MS: an ordinary press is over long before that. The line
 * is the hold itself, so it is the one motion longer than 200ms, and it is
 * linear; with reduced motion asked for it still fills — it is not
 * decoration, it is how far the hold has got — but the bar comes and goes
 * at once.
 *
 * Who it would ask is the first person in her circle, when the television
 * knows it (`name`); otherwise it says what it does without a name
 * (`hold.keepPlain`).
 */
import * as React from 'react';
import { Animated, Easing, StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import type { HouseholdLanguage } from '@wick/contracts';
import { CalmPresence, CalmProgress, useCalmStyles, type CalmTheme } from '@wick/vega-calm-ui';
import { Icon } from '../icons/Icon.js';
import { HOLD_MS, HOLD_SHOWN_FROM_MS, holdProgress } from '../watch/hold.js';
import { words } from '../words/words.js';

export interface HoldLineProps {
  /** When OK went down where it may be held, or null when it is not down (or the press is over). */
  readonly since: number | null;
  readonly language: HouseholdLanguage;
  /** Whom holding would ask to ring her, when the television knows. */
  readonly name?: string | undefined;
}

/** What the bar says. */
export function holdLineWords(language: HouseholdLanguage, name: string | undefined): string {
  const say = words(language);
  return name ? say('hold.keep', { name }) : say('hold.keepPlain');
}

export function HoldLine({ since, language, name }: HoldLineProps): React.JSX.Element {
  const styles = useCalmStyles(makeStyles);
  const fill = React.useRef(new Animated.Value(0)).current;
  const [shown, setShown] = React.useState(false);

  React.useEffect(() => {
    if (since === null) {
      setShown(false);
      fill.stopAnimation();
      return;
    }
    let animation: Animated.CompositeAnimation | undefined;
    const begin = (): void => {
      const done = holdProgress(Date.now() - since) ?? 0;
      fill.setValue(done);
      setShown(true);
      animation = Animated.timing(fill, {
        toValue: 1,
        duration: Math.max(0, (1 - done) * (HOLD_MS - HOLD_SHOWN_FROM_MS)),
        easing: Easing.linear,
        useNativeDriver: false,
      });
      animation.start();
    };
    const wait = HOLD_SHOWN_FROM_MS - (Date.now() - since);
    const timer = wait > 0 ? setTimeout(begin, wait) : undefined;
    if (wait <= 0) begin();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      animation?.stop();
    };
  }, [since, fill]);

  const sentence = holdLineWords(language, name);
  return (
    <CalmPresence shown={shown && since !== null} style={styles.place} pointerEvents="none">
      <View style={styles.bar} accessible accessibilityLabel={sentence} accessibilityLiveRegion="polite">
        <View style={styles.row}>
          <Icon name="hold" />
          <Text style={styles.words}>{sentence}</Text>
        </View>
        <CalmProgress animated={fill} />
      </View>
    </CalmPresence>
  );
}

const makeStyles = (t: CalmTheme) =>
  StyleSheet.create({
    place: {
      position: 'absolute',
      left: 48,
      right: 48,
      bottom: 32,
    },
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
    words: {
      flex: 1,
      color: t.palette.ink,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
  });
