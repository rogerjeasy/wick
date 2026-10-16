/**
 * The home screen of a family member's own television — "Sarah's
 * television" (packages/contracts/src/familyTelevision.ts).
 *
 * The same floor as the resident's home screen (home/HomeScreen.tsx,
 * docs/WICK.md §7): 32pt and up, 7:1 contrast, D-pad and OK only, three
 * choices at most, no red, nothing that moves on its own. Focus is a ring,
 * never colour alone — the only things that take focus here are the
 * buttons of the one card in front, and those are CalmCard's.
 *
 * It says first whose home it looks towards and whose television it is, so
 * nobody takes it for the resident's own screen. Under that, quiet rows:
 * each is there only when it has something to say. Her light least of all
 * leaves a gap when she keeps it to herself.
 *
 * The card sits where the resident's cards sit (ResidentApp.tsx
 * `cardLayer`): over the bottom of the screen. The server wrote its words
 * and its buttons; what is drawn, and what a press does, is decided in
 * familyScreen.ts and tested there. This file only draws.
 *
 * A card reaches well up the screen, and a line it would reach is not
 * drawn at all — never half of one, never the specks of one at the card's
 * rounded corner. Which lines those are is not guessed: this file measures
 * where each line ends and where the card begins, and layout.ts says which
 * are drawn. The lines keep their places either way, so nothing moves when
 * a card comes or goes.
 *
 * The wave is one quiet button of its own, for whoever is in the room,
 * under the quiet rows. It is there only while no card is showing: under a
 * card it pushed the card up over the lines above, and beside a card's
 * answers it is not something to press unread. While the last wave is
 * still on her television the server's sentence stands in the button's
 * place, with nothing to press.
 *
 * While the resident has not allowed this member, the screen is the
 * server's one sentence and nothing else.
 */
import * as React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import { CalmCard, assertContrast, useCalmStyles, useCalmTheme, type CalmTheme } from '@wick/vega-calm-ui';
import { familyLines, startingLines, type Showing, type Wave } from './familyScreen.js';
import { rowsDrawn, waveDrawn } from './layout.js';
import type { LookState } from './looker.js';

export interface FamilyHomeProps {
  /** What the last look came to (looker.ts). Never 'signedOut': by then the pairing screen is up. */
  readonly look: Exclude<LookState, { kind: 'signedOut' }>;
  /** The one card in front, or the sentence that took its place (familyScreen.ts `showing`). */
  readonly shown: Showing;
  /** The address of the picture beside the card, held still between looks (familyScreen.ts `pictureToShow`). */
  readonly pictureUrl?: string | undefined;
  readonly onAction: (actionId: string) => void;
  /** The wave, for a member who may send one (familyScreen.ts `waveOf`). */
  readonly wave?: Wave | undefined;
  readonly onWave?: (() => void) | undefined;
  /** The focus has arrived on the wave, or left it: said to the guard that decides whether a press on it counts (presses.ts). */
  readonly onWaveFocus?: (() => void) | undefined;
  readonly onWaveBlur?: (() => void) | undefined;
  /** How many times Wick has come back on screen. Each time, the focus is taken off the wave again. */
  readonly returns?: number | undefined;
}

/** What a View says of itself once it has been laid out: where it starts, and how tall it is, in dp within its parent. */
interface LaidOut {
  readonly nativeEvent: { readonly layout: { readonly y: number; readonly height: number } };
}

export function FamilyHome({ look, shown, pictureUrl, onAction, wave, onWave, onWaveFocus, onWaveBlur, returns }: FamilyHomeProps): React.JSX.Element {
  // The card checks its own surface; these are the words drawn straight on the ground.
  const theme = useCalmTheme();
  const styles = useCalmStyles(makeStyles);
  assertContrast(theme.palette.ink, theme.palette.ground, theme.minContrast);
  assertContrast(theme.palette.inkDim, theme.palette.ground, theme.minContrast);
  assertContrast(theme.palette.ink, theme.palette.raised, theme.minContrast);

  /** Where each line ends, in dp from the top of the screen, by its words — as laid out, not as estimated. */
  const [rowBottoms, setRowBottoms] = React.useState<Readonly<Record<string, number>>>({});
  /** Where the card now showing begins. Another card has not been measured until it says so itself. */
  const [cardTop, setCardTop] = React.useState<{ readonly key: string; readonly top: number } | undefined>(undefined);
  const measureRow = (row: string) => (event: LaidOut) => {
    const bottom = event.nativeEvent.layout.y + event.nativeEvent.layout.height;
    setRowBottoms((known) => (known[row] === bottom ? known : { ...known, [row]: bottom }));
  };
  const measureCard = (key: string) => (event: LaidOut) => {
    const top = event.nativeEvent.layout.y;
    setCardTop((known) => (known?.key === key && known.top === top ? known : { key, top }));
  };

  // Not allowed, or not allowed any more: the server's sentence, as it stands, and nothing of the home.
  if (look.kind === 'notAllowed') {
    return (
      <View style={[styles.screen, styles.alone]}>
        <Text style={styles.sentence} accessibilityRole="text">
          {look.say}
        </Text>
      </View>
    );
  }

  // No answer yet. Not a blank screen, and not a spinner: the heading the
  // home will have, in its place, and under it — once a look has failed —
  // the one true thing there is to say.
  if (look.kind === 'starting') {
    const starting = startingLines(look.unreachable);
    return (
      <View style={styles.screen}>
        <Text style={styles.heading} accessibilityRole="header" numberOfLines={1}>
          {starting.heading}
        </Text>
        {starting.quiet.map((line) => (
          <Text key={line} style={styles.quiet} numberOfLines={2} accessibilityRole="text">
            {line}
          </Text>
        ))}
      </View>
    );
  }

  const lines = familyLines(look.home, { unreachable: look.unreachable, cardShown: shown.kind !== 'nothing' });

  // A button while a wave can be sent, a sentence while one is on its way — and neither while a card is showing.
  const waving = !wave || !waveDrawn(shown.kind) ? null : wave.kind === 'button' ? (
    <Pressable
      onPress={onWave}
      onFocus={onWaveFocus}
      onBlur={onWaveBlur}
      accessibilityRole="button"
      accessibilityLabel={wave.label}
      // Never where the focus is asked to go: that is the heading above, or a card's first button.
      style={({ focused }: { focused: boolean }) => [styles.wave, focused && styles.waveFocused]}
    >
      <Text style={styles.waveLabel} numberOfLines={1}>
        {wave.label}
      </Text>
    </Pressable>
  ) : (
    <Text style={styles.quiet} numberOfLines={2} accessibilityRole="text">
      {wave.line}
    </Text>
  );

  // The heading, whose television it is, then the quiet rows: top first, which is also what gives way last.
  const rows = [HEADING, OWNER, ...lines.quiet];
  const drawn = rowsDrawn(
    rows.map((row) => rowBottoms[row]),
    shown.kind === 'nothing' ? { showing: false } : { showing: true, top: cardTop?.key === shown.key ? cardTop.top : undefined },
  );
  // A line the card would reach keeps its place and is not drawn — nor read out.
  const unless = (row: number) =>
    drawn[row] ? {} : ({ style: styles.unseen, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const);

  // With no card in front, something has to hold the remote's focus — on
  // Fire OS a key goes to what holds it and to nothing otherwise — and it
  // must not be the wave. So the heading holds it, and does nothing with
  // OK: it has no press. It is mounted afresh each time it takes over — a
  // card has gone, Wick has come back on screen — so that the focus is
  // asked for then, and the wave is a D-pad move away, not where OK lands.
  const holding = shown.kind === 'nothing';

  return (
    <View style={styles.screen}>
      <Pressable
        key={holding ? `holding:${returns ?? 0}` : 'heading'}
        onLayout={measureRow(HEADING)}
        focusable={holding}
        hasTVPreferredFocus={holding}
        // To a screen reader it is what it is: the screen's heading. Not a button, and it promises nothing.
        accessibilityRole="header"
        accessibilityLabel={lines.heading}
        {...unless(0)}
      >
        <Text style={styles.heading} numberOfLines={1}>
          {lines.heading}
        </Text>
      </Pressable>
      <View onLayout={measureRow(OWNER)} {...unless(1)}>
        <Text style={styles.quiet} numberOfLines={1}>
          {lines.owner}
        </Text>
      </View>
      {lines.quiet.map((line, i) => (
        <View key={line} onLayout={measureRow(line)} {...unless(2 + i)}>
          <Text style={styles.quiet} numberOfLines={2} accessibilityRole="text">
            {line}
          </Text>
        </View>
      ))}
      {waving}

      {/* Over the bottom of the screen, like every card on the resident's television. */}
      {shown.kind !== 'nothing' ? (
        <View style={styles.cardLayer} pointerEvents="box-none">
          {/* Measured: where this begins is where the lines above must have ended. */}
          <View onLayout={measureCard(shown.key)}>
            {shown.kind === 'said' ? (
              <CalmCard key={shown.key} headline={shown.say} actions={shown.actions} onAction={onAction} compact />
            ) : (
              <CalmCard
                key={shown.key}
                headline={shown.card.headline}
                detail={shown.card.detail}
                actions={shown.actions}
                onAction={onAction}
                compact
                media={
                  pictureUrl ? (
                    // The door picture, as the resident's door card frames it (cards/DoorCard.tsx).
                    <View style={styles.frame}>
                      <Image source={{ uri: pictureUrl }} style={styles.picture} resizeMode="cover" accessibilityLabel="Picture from the front door camera" />
                    </View>
                  ) : null
                }
              />
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** The two rows that are not the server's words, named for the measuring. Not words a quiet row could be. */
const HEADING = '\u0000heading';
const OWNER = '\u0000owner';

const makeStyles = (t: CalmTheme) =>
  StyleSheet.create({
    // 960x540dp at 1080p; 48dp/32dp keeps everything inside the TV safe area.
    screen: {
      flex: 1,
      backgroundColor: t.palette.ground,
      paddingHorizontal: 48,
      paddingVertical: 32,
      gap: 8,
    },
    alone: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    sentence: {
      color: t.palette.ink,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
      textAlign: 'center',
      paddingHorizontal: 48,
    },
    heading: {
      color: t.palette.ink,
      fontSize: t.fontSize('headline'),
      lineHeight: t.lineHeight('headline'),
    },
    quiet: {
      color: t.palette.inkDim,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
    // The resident's card layer (ResidentApp.tsx), to the dp.
    cardLayer: {
      ...StyleSheet.absoluteFillObject,
      justifyContent: 'flex-end',
      paddingHorizontal: 48,
      paddingBottom: 32,
    },
    // In its place, and not drawn.
    unseen: {
      opacity: 0,
    },
    // Quiet, like the row on the resident's home screen that is there to be found (home/HomeScreen.tsx): as wide as its words.
    wave: {
      alignSelf: 'flex-start',
      borderRadius: 16,
      borderWidth: 4,
      borderColor: 'transparent',
      backgroundColor: t.palette.raised,
      paddingHorizontal: 20,
      paddingVertical: 2,
    },
    // Focus is a ring, never colour alone.
    waveFocused: {
      borderColor: t.palette.focus,
    },
    waveLabel: {
      color: t.palette.ink,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
    // 16:9, the doorbell's own frame, the size the resident's door card gives it.
    frame: {
      width: 256,
      height: 144,
      borderRadius: 12,
      overflow: 'hidden',
      backgroundColor: t.palette.ground,
    },
    picture: {
      width: '100%',
      height: '100%',
    },
  });
