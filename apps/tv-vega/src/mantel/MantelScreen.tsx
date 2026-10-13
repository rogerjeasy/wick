/**
 * Her mantelpiece (packages/contracts/src/mantel.ts): the pictures the
 * family sent that she chose to keep. Opened from the home screen, because
 * she asked for it.
 *
 * One picture at a time, whole, as large as the screen allows
 * (mantelLayout.ts), on the ground colour; under it one quiet line — who
 * it is from, and where it stands: "From Sarah · 2 of 5". Left and Right
 * move between pictures. OK opens a choice in the pattern of the card
 * about her light, with "Leave it" first and focused and "Take it down"
 * second — so a press made without reading changes nothing. Back closes
 * the choice, then the screen.
 *
 * The decisions are in mantel.ts and tested there; this renders what it
 * says and does what it asks: go back to the home screen, ask the server
 * again, tell the server what she took down. Until the server has answered
 * — on opening, and after she takes one down — it shows three dots and
 * nothing else. Nothing on it changes by itself, and there is no timer.
 *
 * The picture holds the remote's focus. On Vega every key reaches the
 * handler below whatever is focused; Android gives a key to the focused
 * view and to nothing when nothing is (FRICTION.md FL-025), so a screen
 * that is all picture would have a dead remote. While the choice is open
 * its two buttons have the focus instead, and while a card is over the
 * screen — the door, which never waits — the card has.
 */
import * as React from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View, useTVEventHandler } from '@amazon-devices/react-native-kepler';
import type { HouseholdLanguage } from '@wick/contracts';
import { CalmCard, fontSize, safe } from '@wick/vega-calm-ui';
import type { Mantel } from '../headless/QueueStore.js';
import { HOLD_MS } from '../watch/hold.js';
import { words } from '../words/words.js';
import { Picture } from './Picture.js';
import { VIEWER_START, caption, inView, viewer, type Viewer, type ViewerEvent } from './mantel.js';
import { MANTEL_GAP_DP, MANTEL_PADDING } from './mantelLayout.js';

export interface MantelScreenProps {
  readonly language: HouseholdLanguage;
  /** What there is to show: the server's answer, or nothing yet (mantel.ts mantelToShow). */
  readonly mantel: Mantel | undefined;
  /** A card is over this screen: the remote is the card's. */
  readonly cardVisible: boolean;
  /** Ask the server for the mantelpiece again: a picture's address did not answer. */
  readonly onAsk: () => void;
  /** She took this one down, with her own press. */
  readonly onTakeDown: (photoId: string) => void;
  /** Back to the home screen. */
  readonly onClose: () => void;
  /** OK was held for two seconds on the picture (watch/hold.ts HOLD_MS). */
  readonly onHold?: (() => void) | undefined;
  /** OK came up on the picture — after a press or a hold (home/reach.ts holdGuard). */
  readonly onKeyUp?: (() => void) | undefined;
}

/** kepler's HWEvent: 0 is key down. */
const KEY_DOWN = 0;

/** Said while the server has not answered. Not a word: three dots, and nothing that moves. */
const WAITING = '…';

export function MantelScreen(props: MantelScreenProps): React.JSX.Element {
  const { language, mantel, cardVisible, onHold, onKeyUp } = props;
  const say = words(language);
  const [state, setState] = React.useState<Viewer>(VIEWER_START);

  // The handlers below are registered once; they read the newest state and props here.
  const current = React.useRef(state);
  const latest = React.useRef(props);
  latest.current = props;

  const run = React.useCallback((event: ViewerEvent) => {
    const next = viewer(current.current, event);
    current.current = next.state;
    setState(next.state);
    for (const effect of next.effects) {
      if (effect.t === 'close') latest.current.onClose();
      else if (effect.t === 'ask') latest.current.onAsk();
      else if (effect.t === 'take_down') latest.current.onTakeDown(effect.photoId);
    }
  }, []);

  // Each answer of the server's, as it comes. An empty one closes the screen.
  React.useEffect(() => {
    run({ t: 'mantel', mantel });
  }, [mantel, run]);

  useTVEventHandler((event) => {
    if (latest.current.cardVisible) return;
    // A press is two events, down and up; it is acted on once.
    if (event.eventKeyAction !== undefined && event.eventKeyAction !== KEY_DOWN) return;
    if (event.eventType === 'left') run({ t: 'move', by: -1 });
    else if (event.eventType === 'right') run({ t: 'move', by: 1 });
  });

  React.useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      run({ t: 'back' });
      return true;
    });
    return () => sub.remove();
  }, [run]);

  const item = inView(state);
  const said = caption(state);
  const line = said ? `${say('mantel.from', { name: said.fromName })} · ${say('mantel.place', { place: said.place, count: said.count })}` : WAITING;
  // "Leave it" first: the card focuses its first button, so OK pressed twice without reading changes nothing.
  const choice = [
    { id: 'leave', label: say('mantel.leave'), kind: 'primary' as const },
    { id: 'take_down', label: say('mantel.takeDown'), kind: 'secondary' as const },
  ];

  return (
    <View style={styles.screen}>
      <Pressable
        onPress={() => run({ t: 'ok' })}
        onLongPress={onHold}
        delayLongPress={HOLD_MS}
        onPressOut={onKeyUp}
        focusable={!cardVisible && !state.choosing}
        hasTVPreferredFocus={!cardVisible && !state.choosing}
        accessibilityRole="button"
        accessibilityLabel={said ? say('mantel.viewLabel', { name: said.fromName, place: said.place, count: said.count }) : WAITING}
        style={styles.view}
      >
        <View style={styles.picture}>
          {item ? (
            <Picture
              // A new address is a new picture to fetch, even for the same one.
              key={item.url}
              uri={item.url}
              fromName={item.fromName}
              language={language}
              onFailed={() => run({ t: 'failed', photoId: item.photoId })}
            />
          ) : null}
        </View>
        <Text style={styles.line} numberOfLines={1} accessibilityLiveRegion="polite">
          {line}
        </Text>
      </Pressable>

      {/* Over the picture, at the bottom, like any card. Not while the door's card is there: one thing asks at a time. */}
      {state.choosing && said && !cardVisible ? (
        <View style={styles.choice}>
          <CalmCard
            compact
            headline={say('mantel.choice', { name: said.fromName })}
            detail={say('mantel.choiceDetail')}
            actions={choice}
            onAction={(id) => run({ t: id === 'take_down' ? 'take_down' : 'leave' })}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: safe.ground,
  },
  view: {
    flex: 1,
    paddingHorizontal: MANTEL_PADDING.horizontal,
    paddingVertical: MANTEL_PADDING.vertical,
    gap: MANTEL_GAP_DP,
  },
  // All the height that is left: mantelLayout.ts MANTEL_PICTURE_AREA.
  picture: {
    flex: 1,
  },
  line: {
    color: safe.inkDim,
    fontSize: fontSize('body'),
    lineHeight: fontSize('body') * 1.4,
    textAlign: 'center',
  },
  // Where ResidentApp's card layer puts a card: the same corner, the same margins.
  choice: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    paddingHorizontal: 48,
    paddingBottom: 32,
  },
});
