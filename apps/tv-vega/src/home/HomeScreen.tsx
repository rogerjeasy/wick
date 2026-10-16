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
 *
 * Four rows (home/homeLayout.ts has the heights): the question, alone; the
 * three films; the quiet line — what is waiting, or who looked in — when
 * there is one; and the pills. The pills are her light in the window, her
 * mantelpiece (packages/contracts/src/mantel.ts) whenever she has kept
 * something, and Easier to see (seeing/seeing.ts), always — none of them
 * ever where the focus starts. They were in the title row and the quiet
 * row once; at 40pt neither has room for one (home/__tests__/
 * homeLayout.test.ts has the numbers), and the question is not what should
 * be cut.
 *
 * Everything here is drawn in the theme she chose (vega-calm-ui
 * CalmPreferences.tsx): with larger text on every word is larger and the
 * films' pictures are shorter, never the other way round; with higher
 * contrast on it is black and white and the focus ring is thicker.
 *
 * The remote is not always this screen's: a card, the mantelpiece, or her
 * pictures filling an idle screen may have it (`cardVisible`). Then nothing
 * here can be focused; and when the remote comes back, the focus goes back
 * to where she was — not to the first film, and not to wherever the
 * platform passed the focus on its way to the card (home/focusMemory.ts).
 *
 * And for one second after the remote comes back, nothing here takes a
 * press (press/settle.ts): after a card goes, her mantelpiece closes, the
 * idle screen ends, a film closes, or Wick returns from behind another app
 * — and the first time the screen appears. A second OK meant for the card
 * that has just gone must not start the film underneath. Only presses: the
 * D-pad moves the focus as always, and OK held for two seconds is still
 * the hold. It counts from the same moment the focus memory counts from —
 * one notion of "the home has just come back".
 *
 * And a press must begin here (press/held.ts). The key coming up is given
 * to whatever has the focus, so OK held down in a film, across Back, and
 * let go on this screen started the film under it. An item that was not
 * told the key went down on it does nothing when the key comes up,
 * however late.
 *
 * And while a card is on screen nothing of this screen is partly visible
 * (home/behind.ts): its rows are left out whole and the card is alone on
 * the ground colour. A card's top edge can fall anywhere, and it used to
 * fall across the question. The screen itself stays, so it still knows
 * where the focus was when its rows come back.
 */
import * as React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import type { HouseholdLanguage } from '@wick/contracts';
import { stylesFor, useCalmTheme, type CalmTheme } from '@wick/vega-calm-ui';
import type { Programme } from '../catalog/catalog.js';
import { pressBegins, pressEnds } from '../press/held.js';
import { HOLD_MS } from '../watch/hold.js';
import { HOME_FOCUS_START, focusOnReturn, focusReported, reachChanged, type HomeFocus } from './focusMemory.js';
import { programmeLine, words } from '../words/words.js';
import { POSTERS } from './posters.js';
import { CAPTION_PADDING_DP, HOME_RING_DP, HOME_SCREEN, PILL_PADDING, QUIET_PADDING, captionPaddingDp, homeHeights, titleLines } from './homeLayout.js';

export interface HomeScreenProps {
  /**
   * Whether this screen's rows are drawn at all (home/behind.ts): not while
   * a card is on screen over it. Then it is the ground colour and nothing
   * else — nothing to see part of, to focus, or for a screen reader to find.
   */
  readonly drawn: boolean;
  /**
   * Wick is the app on screen. Coming back from behind another app, the
   * home has come back within the remote's reach like after anything else.
   */
  readonly inFront: boolean;
  /**
   * Since when OK has been down, as the app heard it (press/held.ts) —
   * whatever was on screen at the time. A key down since before this
   * screen came back is waiting to come up, and presses nothing here.
   */
  readonly okDownSince?: (() => number | null) | undefined;
  /**
   * The language she chose (packages/contracts language.ts). This screen's
   * own words are said in it (words/words.ts); `waiting`, `light` and
   * `lookedIn` arrive already said.
   */
  readonly language: HouseholdLanguage;
  readonly programmes: readonly Programme[];
  readonly onChoose: (programme: Programme) => void;
  /**
   * Something else owns the remote: a card, the mantelpiece, or the idle
   * screen (and, for a moment after it, the key that ended it — mantel/idle.ts).
   */
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
  /**
   * The word on the pill that opens her mantelpiece (words/words.ts) —
   * present only when she has kept at least one picture.
   */
  readonly mantel?: string | undefined;
  readonly onOpenMantel?: (() => void) | undefined;
  /** The word on the pill that opens Easier to see (words/words.ts): always there. */
  readonly seeing: string;
  readonly onOpenSeeing?: (() => void) | undefined;
  /** OK was held for two seconds on whatever has the focus (watch/hold.ts HOLD_MS). */
  readonly onHold?: (() => void) | undefined;
  /**
   * OK came up on whatever has the focus here — after a press or a hold. The
   * app only minds after a hold: it is how it knows her thumb is off the
   * button before the card arrives (home/reach.ts holdGuard).
   */
  readonly onKeyUp?: (() => void) | undefined;
}

export function HomeScreen({ drawn, inFront, okDownSince, language, programmes, onChoose, cardVisible, lastWatchedId, waiting, onOpenWaiting, light, onOpenLight, lookedIn, mantel, onOpenMantel, seeing, onOpenSeeing, onHold, onKeyUp }: HomeScreenProps): React.JSX.Element {
  const say = words(language);
  const theme = useCalmTheme();
  // Never a title cut: at 40pt one may take two lines, and the pictures are shorter for it (home/homeLayout.ts).
  const lines = titleLines(theme, programmes.map((programme) => programme.title));
  const styles = stylesFor(lines === 1 ? makeStyles : makeStylesTwoLineTitles, theme);
  // One quiet line under the films, and a card waiting to be opened comes first.
  const quiet = waiting ? undefined : lookedIn;
  // With that line the films' pictures are shorter, so the screen stays inside 540dp (home/homeLayout.ts).
  const row = waiting !== undefined || quiet !== undefined;

  // Where the focus starts: the film she last watched, or the first. Never a pill.
  const start = `programme:${lastWatchedId ?? programmes[0]?.id}`;
  // And where she was when the remote was last this screen's (home/focusMemory.ts). Only a focus she made is
  // remembered: one reported while the screen is out of the remote's reach, or in the moment after it comes
  // back, is the platform handing the focus along, and is not hers.
  const focus = React.useRef<HomeFocus>(HOME_FOCUS_START);
  focus.current = reachChanged(focus.current, drawn && !cardVisible && inFront, Date.now());
  const reportFocus = (item: string): void => {
    focus.current = focusReported(focus.current, item, Date.now());
  };
  // OK goes down on something here: a press begins — unless the home is out of reach, or the key was already
  // down when it came back (press/held.ts). Kept with the screen, so a film takes it away with it.
  const began = React.useRef<number | null>(null);
  const keyCameUp = React.useRef(false);
  const pressIn = (): void => {
    keyCameUp.current = false;
    began.current = pressBegins({ reachableSince: focus.current.reachableSince, now: Date.now(), okDownSince: okDownSince?.() ?? null });
  };
  // OK comes up on it, seen now. It is acted on only if the press began here, and not in the home's first second
  // back within reach (press/settle.ts). Otherwise it does nothing at all — nothing is started, opened or sent,
  // and the second is not made longer by it.
  // (A press with no key coming up — the platform's click, a screen reader's way of pressing — has no beginning
  // to ask for, and is judged by that second alone. The platform says "the key came up" and then, at once,
  // "pressed": `pressOut` notes the first, and the app is told of it as it always was.)
  const pressOut = (): void => {
    keyCameUp.current = true;
    onKeyUp?.();
  };
  const press =
    (act: (() => void) | undefined) =>
    (): void => {
      const byKey = keyCameUp.current;
      keyCameUp.current = false;
      const acts = pressEnds({ keyCameUp: byKey, reachableSince: focus.current.reachableSince, beganAt: began.current, now: Date.now() });
      began.current = null;
      if (acts) act?.();
    };
  const here = [...programmes.map((programme) => `programme:${programme.id}`), ...(waiting ? ['waiting'] : []), ...(light ? ['light'] : []), ...(mantel ? ['mantel'] : []), 'seeing'];
  const preferred = focusOnReturn(focus.current, here, start);

  // A card is on screen: nothing of this screen is drawn behind it. Left out whole, never partly covered.
  if (!drawn) return <View style={styles.screen} />;

  return (
    <View style={styles.screen}>
      <View style={styles.top}>
        <Text style={[styles.question, styles.questionText]} accessibilityRole="header" numberOfLines={1}>
          {say('home.question')}
        </Text>
      </View>

      <View style={styles.row}>
        {programmes.map((programme) => (
          <Pressable
            key={programme.id}
            onPress={press(() => onChoose(programme))}
            onPressIn={pressIn}
            onLongPress={onHold}
            delayLongPress={HOLD_MS}
            onPressOut={pressOut}
            onFocus={() => reportFocus(`programme:${programme.id}`)}
            focusable={!cardVisible}
            hasTVPreferredFocus={!cardVisible && preferred === `programme:${programme.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${programme.title}. ${programmeLine(programme, language)}`}
            style={({ focused: on }: { focused: boolean }) => [styles.tile, on ? styles.ringOn : styles.ringOff]}
          >
            {/* No picture where the words have left too little room for one. */}
            {homeHeights(theme, row, lines).poster > 0 ? (
              <Image source={POSTERS[programme.id]} style={[styles.poster, row ? styles.posterWithRow : null]} resizeMode="cover" accessibilityLabel="" />
            ) : null}
            {/* Its title. How long it runs is said to the screen reader (above): at 40pt the screen has no line for it. */}
            <View style={styles.caption}>
              <Text style={styles.title} numberOfLines={lines}>
                {programme.title}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>

      {row ? (
        <View style={styles.quietRow}>
          {/* Quiet, and never focused on its own: it is there to be found, not to ask again. */}
          {waiting ? (
            <Pressable
              onPress={press(onOpenWaiting)}
              onPressIn={pressIn}
              onLongPress={onHold}
              delayLongPress={HOLD_MS}
              onPressOut={pressOut}
              onFocus={() => reportFocus('waiting')}
              focusable={!cardVisible}
              hasTVPreferredFocus={!cardVisible && preferred === 'waiting'}
              accessibilityRole="button"
              accessibilityLabel={say('home.waitingLabel', { line: waiting })}
              style={({ focused: on }: { focused: boolean }) => [styles.waiting, styles.quietLine, on ? styles.ringOn : styles.ringOff]}
            >
              {/* The line gets the width; "Open" says what OK does, and is never what is cut. */}
              <Text style={[styles.line, styles.waitingLine]} numberOfLines={1}>
                {waiting}
              </Text>
              <Text style={styles.title}>{say('home.open')}</Text>
            </Pressable>
          ) : (
            // Who looked in: something to read, with nothing to press.
            <View style={[styles.waiting, styles.quietLine, styles.ringOff, styles.unringed]} accessibilityRole="text">
              <Text style={[styles.line, styles.waitingLine]} numberOfLines={1}>
                {quiet}
              </Text>
            </View>
          )}
        </View>
      ) : null}

      {/* The pills: found with the D-pad, never focused on their own. */}
      <View style={styles.pills}>
        {/* Her light in the window. */}
        {light ? (
          <Pressable
            onPress={press(onOpenLight)}
            onPressIn={pressIn}
            onLongPress={onHold}
            delayLongPress={HOLD_MS}
            onPressOut={pressOut}
            onFocus={() => reportFocus('light')}
            focusable={!cardVisible}
            hasTVPreferredFocus={!cardVisible && preferred === 'light'}
            accessibilityRole="button"
            accessibilityLabel={say('home.lightLabel', { light })}
            style={({ focused: on }: { focused: boolean }) => [styles.pill, on ? styles.ringOn : styles.ringOff]}
          >
            <Text style={styles.pillText} numberOfLines={1}>
              {light}
            </Text>
          </Pressable>
        ) : null}
        {/* Her mantelpiece, whenever she has kept something. */}
        {mantel ? (
          <Pressable
            onPress={press(onOpenMantel)}
            onPressIn={pressIn}
            onLongPress={onHold}
            delayLongPress={HOLD_MS}
            onPressOut={pressOut}
            onFocus={() => reportFocus('mantel')}
            focusable={!cardVisible}
            hasTVPreferredFocus={!cardVisible && preferred === 'mantel'}
            accessibilityRole="button"
            accessibilityLabel={say('home.mantelLabel')}
            style={({ focused: on }: { focused: boolean }) => [styles.pill, on ? styles.ringOn : styles.ringOff]}
          >
            <Text style={styles.pillText} numberOfLines={1}>
              {mantel}
            </Text>
          </Pressable>
        ) : null}

        {/* Easier to see (seeing/seeing.ts): always here, whatever else is. */}
        <Pressable
          onPress={press(onOpenSeeing)}
          onPressIn={pressIn}
          onLongPress={onHold}
          delayLongPress={HOLD_MS}
          onPressOut={pressOut}
          onFocus={() => reportFocus('seeing')}
          focusable={!cardVisible}
          hasTVPreferredFocus={!cardVisible && preferred === 'seeing'}
          accessibilityRole="button"
          accessibilityLabel={say('seeing.entryLabel')}
          style={({ focused: on }: { focused: boolean }) => [styles.pill, on ? styles.ringOn : styles.ringOff]}
        >
          <Text style={styles.pillText} numberOfLines={1}>
            {seeing}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (t: CalmTheme) => makeStylesWith(t, 1);
const makeStylesTwoLineTitles = (t: CalmTheme) => makeStylesWith(t, 2);

const makeStylesWith = (t: CalmTheme, titles: 1 | 2) => {
  const ring = t.ring(HOME_RING_DP);
  const heights = homeHeights(t, false, titles);
  const withRow = homeHeights(t, true, titles);
  return StyleSheet.create({
    // 960x540dp at 1080p; 48dp/32dp keeps everything inside the TV safe area.
    screen: {
      flex: 1,
      backgroundColor: t.palette.ground,
      paddingHorizontal: HOME_SCREEN.paddingHorizontal,
      paddingVertical: HOME_SCREEN.paddingVertical,
      gap: HOME_SCREEN.gap,
    },
    // The question, on its own line.
    top: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    question: {
      color: t.palette.ink,
      fontSize: t.fontSize('headline'),
      lineHeight: t.lineHeight('headline'),
    },
    questionText: {
      flex: 1,
    },
    row: {
      flexDirection: 'row',
      gap: HOME_SCREEN.gap,
    },
    tile: {
      flex: 1,
      borderRadius: 16,
      backgroundColor: t.palette.raised,
      overflow: 'hidden',
    },
    // The focus is a ring, never a colour alone (vega-calm-ui theme.ts `ring`): thicker with higher contrast on,
    // where everything that can be pressed is outlined at rest as well. Both take the same room.
    ringOff: ring.rest,
    ringOn: ring.focused,
    // A line with nothing to press: no outline, but the same room as one.
    unringed: {
      borderColor: 'transparent',
    },
    // A fixed height, not an aspect ratio: on the VVD `aspectRatio` with a
    // percentage width came out nearly square and pushed the caption off the
    // 540dp screen. What is left once the words have their room (home/homeLayout.ts).
    poster: {
      width: '100%',
      height: heights.poster,
    },
    posterWithRow: {
      height: withRow.poster,
    },
    waiting: {
      borderRadius: 16,
      backgroundColor: t.palette.raised,
      paddingHorizontal: QUIET_PADDING.horizontal,
      paddingVertical: QUIET_PADDING.vertical,
      flexDirection: 'row',
      alignItems: 'center',
      gap: HOME_SCREEN.gap,
    },
    waitingLine: {
      flex: 1,
    },
    // The quiet line under the films: what is waiting, or who looked in.
    quietRow: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    quietLine: {
      flex: 1,
    },
    // The row of pills, from the left: her light, her mantelpiece, Easier to see.
    pills: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: HOME_SCREEN.gap,
    },
    pill: {
      borderRadius: 16,
      backgroundColor: t.palette.raised,
      paddingHorizontal: PILL_PADDING.horizontal,
      paddingVertical: PILL_PADDING.vertical,
    },
    pillText: {
      color: t.palette.inkDim,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
    caption: {
      paddingVertical: CAPTION_PADDING_DP,
      paddingHorizontal: captionPaddingDp(t),
    },
    title: {
      color: t.palette.ink,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
    line: {
      color: t.palette.inkDim,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
  });
};
