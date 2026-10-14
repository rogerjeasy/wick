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
 * Her mantelpiece (packages/contracts/src/mantel.ts) is opened from a pill
 * at the right-hand end of the quiet row under the films — there whenever
 * she has kept something, and never where the focus starts. Not in the
 * title row beside the light's: at 32pt a second pill does not fit there
 * (home/__tests__/homeLayout.test.ts has the numbers), and the question is
 * not what should be cut.
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
import { fontSize, safe } from '@wick/vega-calm-ui';
import type { Programme } from '../catalog/catalog.js';
import { pressBegins, pressEnds } from '../press/held.js';
import { HOLD_MS } from '../watch/hold.js';
import { HOME_FOCUS_START, focusOnReturn, focusReported, reachChanged, type HomeFocus } from './focusMemory.js';
import { programmeLine, words } from '../words/words.js';
import { POSTERS } from './posters.js';

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
  /** OK was held for two seconds on whatever has the focus (watch/hold.ts HOLD_MS). */
  readonly onHold?: (() => void) | undefined;
  /**
   * OK came up on whatever has the focus here — after a press or a hold. The
   * app only minds after a hold: it is how it knows her thumb is off the
   * button before the card arrives (home/reach.ts holdGuard).
   */
  readonly onKeyUp?: (() => void) | undefined;
}

export function HomeScreen({ drawn, inFront, okDownSince, language, programmes, onChoose, cardVisible, lastWatchedId, waiting, onOpenWaiting, light, onOpenLight, lookedIn, mantel, onOpenMantel, onHold, onKeyUp }: HomeScreenProps): React.JSX.Element {
  const say = words(language);
  // One quiet row under the films, and a card waiting to be opened comes first.
  const quiet = waiting ? undefined : lookedIn;
  // With anything in that row the films' pictures are thirty dp shorter, so the screen stays inside 540dp.
  const row = waiting !== undefined || quiet !== undefined || mantel !== undefined;

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
  const here = [...programmes.map((programme) => `programme:${programme.id}`), ...(light ? ['light'] : []), ...(waiting ? ['waiting'] : []), ...(mantel ? ['mantel'] : [])];
  const preferred = focusOnReturn(focus.current, here, start);

  // A card is on screen: nothing of this screen is drawn behind it. Left out whole, never partly covered.
  if (!drawn) return <View style={styles.screen} />;

  return (
    <View style={styles.screen}>
      <View style={styles.top}>
        <Text style={[styles.question, styles.questionText]} accessibilityRole="header" numberOfLines={1}>
          {say('home.question')}
        </Text>
        {/* Never focused on its own: the films are what the screen is for. */}
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
            style={({ focused: on }: { focused: boolean }) => [styles.light, on && styles.tileFocused]}
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
            style={({ focused: on }: { focused: boolean }) => [styles.tile, on && styles.tileFocused]}
          >
            <Image source={POSTERS[programme.id]} style={[styles.poster, row ? styles.posterWithRow : null]} resizeMode="cover" accessibilityLabel="" />
            <View style={styles.caption}>
              <Text style={styles.title} numberOfLines={1}>
                {programme.title}
              </Text>
              <Text style={styles.line} numberOfLines={1}>
                {programmeLine(programme, language)}
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
              style={({ focused: on }: { focused: boolean }) => [styles.waiting, styles.quietLine, on && styles.tileFocused]}
            >
              {/* The line gets the width; "Open" says what OK does, and is never what is cut. */}
              <Text style={[styles.line, styles.waitingLine]} numberOfLines={1}>
                {waiting}
              </Text>
              <Text style={styles.title}>{say('home.open')}</Text>
            </Pressable>
          ) : quiet ? (
            // Who looked in: something to read, with nothing to press.
            <View style={[styles.waiting, styles.quietLine]} accessibilityRole="text">
              <Text style={[styles.line, styles.waitingLine]} numberOfLines={1}>
                {quiet}
              </Text>
            </View>
          ) : (
            // Nothing to say: the pill keeps its place at the right-hand end.
            <View style={styles.quietLine} />
          )}

          {/* Her mantelpiece. Found with the D-pad, never focused on its own. */}
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
              style={({ focused: on }: { focused: boolean }) => [styles.light, on && styles.tileFocused]}
            >
              <Text style={styles.line} numberOfLines={1}>
                {mantel}
              </Text>
            </Pressable>
          ) : null}
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
  // The row under the films: one quiet thing on the left, and at its right-hand end the mantelpiece's pill.
  quietRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
  },
  quietLine: {
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
