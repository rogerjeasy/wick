/**
 * The home screen — what would you like to watch?
 *
 * The same floor as every card (docs/WICK.md §7): 32pt and up, 7:1
 * contrast, D-pad and OK only, three choices at most, no red, nothing that
 * moves on its own. Focus is a ring, never colour alone.
 *
 * While a card is on screen the tiles give up focus, so the D-pad cannot
 * wander off the card's buttons onto something behind it.
 *
 * OK held for two seconds on anything here is not a press: it brings the
 * card that offers to ask someone to ring her (packages/contracts/src/
 * reach.ts). The platform's own long press tells the two apart, so the film
 * under her thumb does not start when she lets go. From 0.4 s the hold
 * shows itself (press/HoldLine.tsx): a bar at the bottom says what holding
 * will do and a line fills to the two seconds. Let go before then, and the
 * bar goes and nothing happens at all.
 *
 * Her day first (home/herDay.ts, contracts today.ts): when the server says
 * one, the question gives way to "Good morning, Margaret." and the date, and
 * a quiet panel under them says who is coming — "Maria usually comes
 * tomorrow at 9 am." It is read, never pressed: nothing in it takes the
 * focus, and the focus still starts on a film. What gives way to make room
 * for it is homeLayout.ts careLayout's to say: the films' pictures first,
 * never a word cut.
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
import { CalmFocusScale, CalmProgress, stylesFor, useCalmTheme, type CalmTheme } from '@wick/vega-calm-ui';
import type { Programme } from '../catalog/catalog.js';
import { pressBegins, pressEnds } from '../press/held.js';
import { HOLD_MS } from '../watch/hold.js';
import { HoldLine } from '../press/HoldLine.js';
import { HOME_FOCUS_START, focusOnReturn, focusReported, reachChanged, type HomeFocus } from './focusMemory.js';
import { programmeLine, words } from '../words/words.js';
import { POSTERS } from './posters.js';
import {
  CAPTION_PADDING_DP,
  CHIP_INSET_DP,
  CHIP_PADDING,
  DAY_GAP_DP,
  DAY_LINE_GAP_DP,
  DAY_PADDING,
  HOME_RING_DP,
  HOME_SCREEN,
  PILL_ICON_GAP_DP,
  PILL_PADDING,
  QUIET_PADDING,
  TIGHT_CAPTION_PADDING,
  TILE_PROGRESS_DP,
  captionPaddingDp,
  homeHeights,
  homeLayout,
  pillsWithWords,
  titleLines,
  type PillSpec,
} from './homeLayout.js';
import { Icon } from '../icons/Icon.js';
import type { IconName } from '../icons/icons.js';
import { fraction, minutesLeft } from '../watch/transport.js';
import type { HomeDay } from './herDay.js';

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
  /** Her films, in the order she meets them (home/order.ts): one she left part-way first. */
  readonly programmes: readonly Programme[];
  /**
   * Where she left each film she stopped part-way (watch/resume.ts), by its
   * id: its tile says "Carry on", how long is left, and draws the line.
   */
  readonly resumeAt?: Readonly<Record<string, number>> | undefined;
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
  /** The words on the pill that opens How Wick works (tour/tour.ts), when the tour is offered. */
  readonly tour?: string | undefined;
  readonly onOpenTour?: (() => void) | undefined;
  /**
   * Her day, in her language (home/herDay.ts): the greeting, the date and
   * who is coming. Absent when the server says none, or the one it said is
   * over: then the home screen opens on the question, as it always did.
   */
  readonly day?: HomeDay | undefined;
  /** OK was held for two seconds on whatever has the focus (watch/hold.ts HOLD_MS). */
  readonly onHold?: (() => void) | undefined;
  /**
   * Whom holding OK would ask to ring her, when the television knows
   * (press/HoldLine.tsx). The home message does not say who is first in her
   * circle (packages/contracts light.ts HomeState), so today it is never
   * known here and the line says what holding does without a name.
   */
  readonly holdName?: string | undefined;
  /**
   * OK came up on whatever has the focus here — after a press or a hold. The
   * app only minds after a hold: it is how it knows her thumb is off the
   * button before the card arrives (home/reach.ts holdGuard).
   */
  readonly onKeyUp?: (() => void) | undefined;
}

export function HomeScreen(props: HomeScreenProps): React.JSX.Element {
  const { drawn, inFront, okDownSince, language, programmes, resumeAt, onChoose, cardVisible, lastWatchedId, waiting, onOpenWaiting, light, onOpenLight, lookedIn, mantel, onOpenMantel, seeing, onOpenSeeing, tour, onOpenTour, day, onHold, holdName, onKeyUp } = props;
  const say = words(language);
  const theme = useCalmTheme();
  // Never a title cut: at 40pt one may take two lines, and the pictures are shorter for it (home/homeLayout.ts).
  const lines = titleLines(theme, programmes.map((programme) => programme.title));
  const styles = stylesFor(lines === 1 ? makeStyles : makeStylesTwoLineTitles, theme);
  // One quiet line under the films, and a card waiting to be opened comes first.
  const quiet = waiting ? undefined : lookedIn;
  // With that line the films' pictures are shorter, so the screen stays inside 540dp (home/homeLayout.ts).
  const row = waiting !== undefined || quiet !== undefined;
  // A film she left part-way: how long is left of the longest-left of them, for measuring its chip.
  const partWay = programmes.filter((programme) => (resumeAt?.[programme.id] ?? 0) > 0);
  const leftOf = (programme: Programme): number => minutesLeft(resumeAt?.[programme.id] ?? 0, programme.durationMs);
  const widestLeft = partWay.reduce((most, programme) => Math.max(most, leftOf(programme)), 0);
  // Her day, where there is one: what the headline says, where the date goes, what the panel holds — where "Carry on"
  // goes — and the pictures what is left (home/homeLayout.ts).
  const layout = homeLayout(theme, {
    quiet: row,
    titles: lines,
    day,
    carryOn: partWay.length > 0 ? { carryOn: say('home.carryOn'), left: say('home.left', { minutes: widestLeft }) } : undefined,
  });
  const care = layout.care;
  const poster = layout.poster;
  // The pills: which show their words at rest, and which only with the focus (home/homeLayout.ts pillsWithWords).
  const pills: (PillSpec & { readonly icon: IconName; readonly label: string; readonly open?: (() => void) | undefined })[] = [
    ...(light ? [{ id: 'light', words: light, icon: 'light' as const, label: say('home.lightLabel', { light }), open: onOpenLight }] : []),
    ...(mantel ? [{ id: 'mantel', words: mantel, icon: 'mantel' as const, label: say('home.mantelLabel'), open: onOpenMantel }] : []),
    { id: 'seeing', words: seeing, icon: 'seeing' as const, label: say('seeing.entryLabel'), open: onOpenSeeing },
    ...(tour ? [{ id: 'tour', words: tour, icon: 'tour' as const, label: say('home.tourLabel'), open: onOpenTour }] : []),
  ];
  const withWords = pillsWithWords(theme, pills);
  // What has the focus now, for the tile that grows with it and the pill that opens its words.
  const [focused, setFocused] = React.useState<string | null>(null);

  // Where the focus starts: the film she last watched, or the first. Never a pill.
  const start = `programme:${lastWatchedId ?? programmes[0]?.id}`;
  // And where she was when the remote was last this screen's (home/focusMemory.ts). Only a focus she made is
  // remembered: one reported while the screen is out of the remote's reach, or in the moment after it comes
  // back, is the platform handing the focus along, and is not hers.
  const focus = React.useRef<HomeFocus>(HOME_FOCUS_START);
  focus.current = reachChanged(focus.current, drawn && !cardVisible && inFront, Date.now());
  const reportFocus = (item: string): void => {
    focus.current = focusReported(focus.current, item, Date.now());
    setFocused(item);
  };
  const reportBlur = (item: string) => (): void => setFocused((now) => (now === item ? null : now));
  // OK goes down on something here: a press begins — unless the home is out of reach, or the key was already
  // down when it came back (press/held.ts). Kept with the screen, so a film takes it away with it.
  const began = React.useRef<number | null>(null);
  const keyCameUp = React.useRef(false);
  // Since when OK has been down on something here, for the hold line: from the key going down to it coming up,
  // or to the hold it became. Not while anything else has the remote.
  const [holdSince, setHoldSince] = React.useState<number | null>(null);
  const pressIn = (): void => {
    keyCameUp.current = false;
    const now = Date.now();
    began.current = pressBegins({ reachableSince: focus.current.reachableSince, now, okDownSince: okDownSince?.() ?? null });
    setHoldSince(now);
  };
  // Held for the two seconds: the line has done its work, and the card it asked for is on its way.
  const held = (): void => {
    setHoldSince(null);
    onHold?.();
  };
  const reachable = drawn && !cardVisible;
  React.useEffect(() => {
    if (!reachable) setHoldSince(null);
  }, [reachable]);
  // OK comes up on it, seen now. It is acted on only if the press began here, and not in the home's first second
  // back within reach (press/settle.ts). Otherwise it does nothing at all — nothing is started, opened or sent,
  // and the second is not made longer by it.
  // (A press with no key coming up — the platform's click, a screen reader's way of pressing — has no beginning
  // to ask for, and is judged by that second alone. The platform says "the key came up" and then, at once,
  // "pressed": `pressOut` notes the first, and the app is told of it as it always was.)
  const pressOut = (): void => {
    keyCameUp.current = true;
    setHoldSince(null);
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
  const here = [...programmes.map((programme) => `programme:${programme.id}`), ...(waiting ? ['waiting'] : []), ...pills.map((pill) => pill.id)];
  const preferred = focusOnReturn(focus.current, here, start);

  // A card is on screen: nothing of this screen is drawn behind it. Left out whole, never partly covered.
  if (!drawn) return <View style={styles.screen} />;

  return (
    <View style={styles.screen}>
      <View style={styles.top}>
        <Text style={[styles.question, styles.questionText]} accessibilityRole="header" numberOfLines={1}>
          {care ? care.headline : say('home.question')}
        </Text>
        {care?.dateBeside ? (
          <Text style={styles.date} numberOfLines={1}>
            {care.dateBeside}
          </Text>
        ) : null}
      </View>

      {/* Who is coming: to be read, never pressed. The date leads it when the headline's row had no room for it. */}
      {care && care.panel.length > 0 ? (
        <View style={styles.day} accessibilityRole="text">
          {care.panel.map((sentence, i) => (
            <Text key={`${i}:${sentence}`} style={styles.dayLine} numberOfLines={care.panelLines[i]}>
              {sentence}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.row}>
        {programmes.map((programme) => {
          const item = `programme:${programme.id}`;
          const at = resumeAt?.[programme.id] ?? 0;
          const carry = at > 0 ? layout.carryOn : undefined;
          const minutes = leftOf(programme);
          return (
            <CalmFocusScale key={programme.id} focused={focused === item && !cardVisible} style={styles.tileSlot}>
              <Pressable
                onPress={press(() => onChoose(programme))}
                onPressIn={pressIn}
                onLongPress={held}
                delayLongPress={HOLD_MS}
                onPressOut={pressOut}
                onFocus={() => reportFocus(item)}
                onBlur={reportBlur(item)}
                focusable={!cardVisible}
                hasTVPreferredFocus={!cardVisible && preferred === item}
                accessibilityRole="button"
                accessibilityLabel={carry ? say('home.carryOnLabel', { title: programme.title, minutes }) : `${programme.title}. ${programmeLine(programme, language)}`}
                style={({ focused: on }: { focused: boolean }) => [styles.tile, on ? styles.tileOn : null, on ? styles.ringOn : styles.ringOff]}
              >
                {/* No picture where the words have left too little room for one. */}
                {poster > 0 ? (
                  <View style={[styles.poster, row ? styles.posterWithRow : null, { height: poster }]}>
                    <Image source={POSTERS[programme.id]} style={styles.posterImage} resizeMode="cover" accessibilityLabel="" />
                    {/* Carry on: on chips of their own over the picture, never on the picture itself, and the line along its foot. */}
                    {carry === 'over' ? (
                      <>
                        <View style={[styles.chip, styles.chipCarry]}>
                          <Text style={styles.chipCarryText}>{say('home.carryOn')}</Text>
                        </View>
                        <View style={[styles.chip, styles.chipLeft]}>
                          <Text style={styles.chipLeftText}>{say('home.left', { minutes })}</Text>
                        </View>
                        <View style={styles.posterLine}>
                          <CalmProgress fraction={fraction(at, programme.durationMs)} heightDp={TILE_PROGRESS_DP} />
                        </View>
                      </>
                    ) : null}
                  </View>
                ) : null}
                {/* Its title. How long it runs is said to the screen reader (above): at 40pt the screen has no line for it. */}
                <View style={[styles.caption, layout.tightCaption ? styles.captionTight : null]}>
                  {carry === 'caption' || carry === 'line' ? (
                    <View style={layout.tightCaption ? styles.captionLineTight : styles.captionLine}>
                      <CalmProgress fraction={fraction(at, programme.durationMs)} heightDp={TILE_PROGRESS_DP} />
                    </View>
                  ) : null}
                  <Text style={styles.title} numberOfLines={lines}>
                    {programme.title}
                  </Text>
                  {carry === 'caption' ? <Text style={styles.carryLine}>{say('home.carryOn')}</Text> : null}
                </View>
              </Pressable>
            </CalmFocusScale>
          );
        })}
      </View>

      {row ? (
        <View style={styles.quietRow}>
          {/* Quiet, and never focused on its own: it is there to be found, not to ask again. */}
          {waiting ? (
            <Pressable
              onPress={press(onOpenWaiting)}
              onPressIn={pressIn}
              onLongPress={held}
              delayLongPress={HOLD_MS}
              onPressOut={pressOut}
              onFocus={() => reportFocus('waiting')}
              onBlur={reportBlur('waiting')}
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

      {/* The pills: found with the D-pad, never focused on their own. Each its icon and its words — or, where the row
          has no room for all of them, its icon alone until the focus is on it (home/homeLayout.ts pillsWithWords). */}
      <View style={styles.pills}>
        {pills.map((pill) => {
          const open = withWords.has(pill.id) || focused === pill.id;
          return (
            <Pressable
              key={pill.id}
              onPress={press(pill.open)}
              onPressIn={pressIn}
              onLongPress={held}
              delayLongPress={HOLD_MS}
              onPressOut={pressOut}
              onFocus={() => reportFocus(pill.id)}
              onBlur={reportBlur(pill.id)}
              focusable={!cardVisible}
              hasTVPreferredFocus={!cardVisible && preferred === pill.id}
              accessibilityRole="button"
              accessibilityLabel={pill.label}
              style={({ focused: on }: { focused: boolean }) => [styles.pill, on ? styles.pillOn : null, on ? styles.ringOn : styles.ringOff]}
            >
              <Icon name={pill.icon} />
              {open ? (
                <Text style={styles.pillText} numberOfLines={1}>
                  {pill.words}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      {/* Holding OK: from 0.4 s, what it will do, and how far it has got (press/HoldLine.tsx). */}
      <HoldLine since={holdSince} language={language} name={holdName} />
    </View>
  );
}

const makeStyles = (t: CalmTheme) => makeStylesWith(t, 1);
const makeStylesTwoLineTitles = (t: CalmTheme) => makeStylesWith(t, 2);

const makeStylesWith = (t: CalmTheme, titles: 1 | 2) => {
  const ring = t.ring(HOME_RING_DP);
  const heights = homeHeights(t, false, titles);
  const withRow = homeHeights(t, true, titles);
  const chip = {
    position: 'absolute' as const,
    borderRadius: 12,
    paddingHorizontal: CHIP_PADDING.horizontal,
    paddingVertical: CHIP_PADDING.vertical,
    borderWidth: t.cardEdgeDp,
    borderColor: t.palette.ink,
  };
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
    // The date, at the end of the greeting's row: quieter than the greeting, on the same line.
    date: {
      color: t.palette.inkDim,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
      marginLeft: HOME_SCREEN.gap,
    },
    // Her day: one quiet panel under the greeting, closer to it than the rows are to each other.
    day: {
      marginTop: DAY_GAP_DP - HOME_SCREEN.gap,
      borderRadius: 16,
      backgroundColor: t.palette.raised,
      paddingHorizontal: DAY_PADDING.horizontal,
      paddingVertical: DAY_PADDING.vertical,
      gap: DAY_LINE_GAP_DP,
    },
    dayLine: {
      color: t.palette.ink,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
    row: {
      flexDirection: 'row',
      gap: HOME_SCREEN.gap,
    },
    // Each film's place in the row: it grows with the focus (CalmFocusScale), the tile inside it fills it.
    tileSlot: {
      flex: 1,
    },
    tile: {
      flexGrow: 1,
      borderRadius: 16,
      backgroundColor: t.palette.raised,
      overflow: 'hidden',
    },
    // The focused tile: a step up from the others, as well as its ring and its size — never colour alone.
    tileOn: {
      backgroundColor: t.palette.raisedHigh,
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
    posterImage: {
      width: '100%',
      height: '100%',
    },
    chip,
    // "Carry on", in the amber of a first button: its words in the dark of the ground (10.3:1).
    chipCarry: {
      top: CHIP_INSET_DP,
      left: CHIP_INSET_DP,
      backgroundColor: t.palette.accent,
    },
    chipCarryText: {
      color: t.palette.ground,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
      fontWeight: '700',
    },
    // How long is left, at the foot of the picture, just above the line.
    chipLeft: {
      right: CHIP_INSET_DP,
      bottom: CHIP_INSET_DP + TILE_PROGRESS_DP + CHIP_INSET_DP,
      backgroundColor: t.palette.raisedHigh,
    },
    chipLeftText: {
      color: t.palette.ink,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
    posterLine: {
      position: 'absolute',
      left: CHIP_INSET_DP,
      right: CHIP_INSET_DP,
      bottom: CHIP_INSET_DP,
    },
    // "Carry on" as a line of the caption, where the picture had no room for it, and the line above it.
    captionTight: {
      paddingTop: TIGHT_CAPTION_PADDING.top,
      paddingBottom: TIGHT_CAPTION_PADDING.bottom,
    },
    captionLine: {
      position: 'absolute',
      top: (CAPTION_PADDING_DP - TILE_PROGRESS_DP) / 2,
      left: captionPaddingDp(t),
      right: captionPaddingDp(t),
    },
    captionLineTight: {
      position: 'absolute',
      top: (TIGHT_CAPTION_PADDING.top - TILE_PROGRESS_DP) / 2,
      left: captionPaddingDp(t),
      right: captionPaddingDp(t),
    },
    // In the amber of the flame: 9:1 on a tile, 8:1 on the focused one; white with higher contrast on.
    carryLine: {
      color: t.palette.accent,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
      fontWeight: '700',
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
      flexDirection: 'row',
      alignItems: 'center',
      gap: PILL_ICON_GAP_DP,
      borderRadius: 16,
      backgroundColor: t.palette.raised,
      paddingHorizontal: PILL_PADDING.horizontal,
      paddingVertical: PILL_PADDING.vertical,
    },
    pillOn: {
      backgroundColor: t.palette.raisedHigh,
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
