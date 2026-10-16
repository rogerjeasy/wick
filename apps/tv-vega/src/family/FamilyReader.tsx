/**
 * Something to read on a family member's own television — her week, a page
 * at a time (packages/contracts/src/familyTelevision.ts `pages`).
 *
 * The floor of every Wick screen: 32pt and up, 7:1 contrast, D-pad and OK
 * only, no red, nothing that moves on its own. A page stays until a key
 * turns it: OK or Right goes on, Left goes back, Back closes. What each
 * does — and that leaving from the last page is what says it was read — is
 * decided in reader.ts and tested there. This file draws one page.
 *
 * One button holds the focus, as a ring, and says what OK does. Every word
 * of the page is the server's; the button's and the counter's are the
 * television's own.
 */
import * as React from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View, useTVEventHandler } from '@amazon-devices/react-native-kepler';
import { assertContrast, useCalmStyles, useCalmTheme, type CalmTheme } from '@wick/vega-calm-ui';
import { READER_LINE_HEIGHT, READER_PAGE_LINES, readerKey, readerPage, type ReaderKey, type Reading } from './reader.js';

export interface FamilyReaderProps {
  readonly reading: Reading;
  /** OK or Right, Left, Back. */
  readonly onKey: (key: ReaderKey) => void;
}

export function FamilyReader({ reading, onKey }: FamilyReaderProps): React.JSX.Element {
  const theme = useCalmTheme();
  const styles = useCalmStyles(makeStyles);
  const button = theme.actionColours('primary');
  assertContrast(theme.palette.ink, theme.palette.ground, theme.minContrast);
  assertContrast(theme.palette.inkDim, theme.palette.ground, theme.minContrast);
  assertContrast(button.label, button.background, theme.minContrast);

  // Registered once; they read the newest handler from here.
  const latest = React.useRef(onKey);
  latest.current = onKey;

  // Right and Left. OK is the button's own press, below — heard once on both televisions.
  useTVEventHandler((event) => {
    const key = readerKey(event);
    if (key) latest.current(key);
  });

  React.useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      latest.current('back');
      return true;
    });
    return () => sub.remove();
  }, []);

  const page = readerPage(reading);

  return (
    <View style={styles.screen}>
      <View style={styles.page}>
        {/* The server's line breaks are lines here: a day of her week is a line for the day and one for each thing. */}
        <Text style={styles.words} numberOfLines={READER_PAGE_LINES} accessibilityLiveRegion="polite">
          {page.text}
        </Text>
      </View>
      <View style={styles.foot}>
        <Pressable
          onPress={() => onKey('next')}
          hasTVPreferredFocus
          accessibilityRole="button"
          accessibilityLabel={page.last ? 'All right' : 'Next page'}
          style={({ focused }: { focused: boolean }) => [styles.button, focused && styles.buttonFocused]}
        >
          <Text style={styles.buttonLabel}>{page.last ? 'All right' : 'Next page'}</Text>
        </Pressable>
        {page.counter ? (
          <Text style={styles.counter} accessibilityRole="text">
            {page.counter}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (t: CalmTheme) =>
  StyleSheet.create({
    // 960x540dp at 1080p; 48dp/32dp keeps everything inside the TV safe area.
    screen: {
      flex: 1,
      backgroundColor: t.palette.ground,
      paddingHorizontal: 48,
      paddingVertical: 32,
      gap: 16,
    },
    page: {
      flex: 1,
      justifyContent: 'center',
    },
    // 540 - 2x32 (safe area) - 16 (gap) - 78 (the button) = 382dp for the page; nine lines at 1.3 are 374.
    words: {
      color: t.palette.ink,
      fontSize: t.fontSize('body'),
      lineHeight: t.fontSize('body') * READER_LINE_HEIGHT,
    },
    foot: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 24,
    },
    // The card's own button (vega-calm-ui CalmCard), a little less tall: the page needs the room.
    button: {
      paddingVertical: 16,
      paddingHorizontal: 32,
      borderRadius: 12,
      borderWidth: 2,
      borderColor: 'transparent',
      backgroundColor: t.actionColours('primary').background,
    },
    // Focus is a ring, never a colour change alone.
    buttonFocused: {
      borderColor: t.palette.focus,
    },
    buttonLabel: {
      color: t.actionColours('primary').label,
      fontSize: t.fontSize('body'),
    },
    counter: {
      color: t.palette.inkDim,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
  });
