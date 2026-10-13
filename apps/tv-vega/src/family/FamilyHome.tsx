/**
 * The home screen of a family member's own television — "Sarah's
 * television" (packages/contracts/src/familyTelevision.ts).
 *
 * The same floor as the resident's home screen (home/HomeScreen.tsx,
 * docs/WICK.md Part 5): 32pt and up, 7:1 contrast, D-pad and OK only, three
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
 * The wave is one quiet button of its own, for whoever is in the room:
 * under the quiet rows when no card is showing, under the card when one
 * is. It never asks for the focus — a card's first button does — so an OK
 * pressed without reading answers the card or nothing, and never waves.
 * While the last wave is still on her television the server's sentence
 * stands in the button's place, with nothing to press.
 *
 * While the resident has not allowed this member, the screen is the
 * server's one sentence and nothing else.
 */
import * as React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import { CalmCard, assertContrast, fontSize, safe } from '@wick/vega-calm-ui';
import { familyLines, unreachableLine, type Showing, type Wave } from './familyScreen.js';
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
}

export function FamilyHome({ look, shown, pictureUrl, onAction, wave, onWave }: FamilyHomeProps): React.JSX.Element {
  // The card checks its own surface; these are the words drawn straight on the ground.
  assertContrast(safe.ink, safe.ground);
  assertContrast(safe.inkDim, safe.ground);
  assertContrast(safe.ink, safe.raised);

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

  // No answer yet: nothing, rather than a spinner. Only once the looks have failed is there something true to say.
  if (look.kind === 'starting') {
    return (
      <View style={styles.screen}>
        {look.unreachable ? (
          <Text style={styles.quiet} numberOfLines={2} accessibilityRole="text">
            {unreachableLine(undefined)}
          </Text>
        ) : null}
      </View>
    );
  }

  const lines = familyLines(look.home, { unreachable: look.unreachable, cardShown: shown.kind !== 'nothing' });

  // The same thing in either place: a button while a wave can be sent, a sentence while one is on its way.
  const waving = !wave ? null : wave.kind === 'button' ? (
    <Pressable
      onPress={onWave}
      accessibilityRole="button"
      accessibilityLabel={wave.label}
      // Never the preferred focus: that is the card's first button, when there is a card.
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

  return (
    <View style={styles.screen}>
      <Text style={styles.heading} accessibilityRole="header" numberOfLines={1}>
        {lines.heading}
      </Text>
      <Text style={styles.quiet} numberOfLines={1}>
        {lines.owner}
      </Text>
      {lines.quiet.map((line) => (
        <Text key={line} style={styles.quiet} numberOfLines={2} accessibilityRole="text">
          {line}
        </Text>
      ))}
      {shown.kind === 'nothing' ? waving : null}

      {/* Over the bottom of the screen, like every card on the resident's television. */}
      {shown.kind !== 'nothing' ? (
        <View style={styles.cardLayer} pointerEvents="box-none">
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
          {/* After the card's buttons, for the D-pad and for the eye. */}
          {waving}
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
    gap: 8,
  },
  alone: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  sentence: {
    color: safe.ink,
    fontSize: fontSize('body'),
    lineHeight: fontSize('body') * 1.4,
    textAlign: 'center',
    paddingHorizontal: 48,
  },
  heading: {
    color: safe.ink,
    fontSize: fontSize('headline'),
    lineHeight: fontSize('headline') * 1.25,
  },
  quiet: {
    color: safe.inkDim,
    fontSize: fontSize('body'),
    lineHeight: fontSize('body') * 1.4,
  },
  // The resident's card layer (ResidentApp.tsx), to the dp — with room under the card for the wave.
  cardLayer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    paddingHorizontal: 48,
    paddingBottom: 32,
    gap: 8,
  },
  // Quiet, like the row on the resident's home screen that is there to be found (home/HomeScreen.tsx): as wide as its words.
  wave: {
    alignSelf: 'flex-start',
    borderRadius: 16,
    borderWidth: 4,
    borderColor: 'transparent',
    backgroundColor: safe.raised,
    paddingHorizontal: 20,
    paddingVertical: 2,
  },
  // Focus is a ring, never colour alone.
  waveFocused: {
    borderColor: safe.focus,
  },
  waveLabel: {
    color: safe.ink,
    fontSize: fontSize('body'),
    lineHeight: fontSize('body') * 1.4,
  },
  // 16:9, the doorbell's own frame, the size the resident's door card gives it.
  frame: {
    width: 256,
    height: 144,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: safe.ground,
  },
  picture: {
    width: '100%',
    height: '100%',
  },
});
