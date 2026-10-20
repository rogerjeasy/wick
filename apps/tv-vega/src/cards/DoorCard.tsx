/**
 * Phase 1 shows the line and the buttons immediately; Phase 2 patches the
 * image and then the description in as they arrive.
 * The useful half of the card is never blocked by the interesting half.
 * See docs/WICK-TECHNICAL.md §5.2, §9.1.
 *
 * Two things here come from measurement rather than design:
 *
 *   - There is NO image in Phase 1. Ring's image retrieval takes ~3.1s and
 *     there is no live-capture endpoint at all (FRICTION.md FL-005), so the
 *     picture is a patch like the description.
 *   - The middle button ("Ring the hallway chime") is absent when the
 *     household has no playable Ring Chime — the agent decides that from the
 *     device list; this component simply renders however many actions it is
 *     given. Pressing it keeps the card, and a patch adds the notice saying
 *     whether the chime rang (M1).
 *
 * The detail slot can also carry M4's schedule match ("Maria is expected
 * around now": when she is due, never who has come), available from Phase 1, before the vision
 * description ever patches in — see doorDetail.ts for the priority between
 * them.
 *
 * Bottom of the screen, never full screen: it must not cover or silence
 * whatever the resident is already watching. The film waits under it, as
 * under a note (NaturalBreakEngine.ts holdsProgramme): she may get up.
 *
 * Sized for what the television actually reports — 960x540dp at 1080p, not
 * 1920x1080. At the design system's 48pt headline / 32pt body floor, the
 * earlier stacked layout (a 320dp frame above the text) ran off the top of
 * the screen on the VVD. The frame now sits in a reserved 16:9 box beside
 * the text, so the card fits and the picture arriving moves nothing.
 *
 * Compact (CalmCard's `compact`): at the full 48pt headline the card stood
 * 390dp of the screen's 540 and hid most of the programme. With the
 * headline on one line at body size it is a little over half the screen.
 */
import * as React from 'react';
import { Image, StyleSheet, View } from '@amazon-devices/react-native-kepler';
import type { CardAction, DoorCard as DoorCardModel, HouseholdLanguage } from '@wick/contracts';
import { CalmText, TwoPhaseCard } from '@wick/vega-calm-ui';
import { words } from '../words/words.js';
import { doorDetailText } from './doorDetail.js';

export interface DoorCardProps {
  readonly card: DoorCardModel;
  /** For the sentence about who it looks like, and what the screen reader calls the picture; the rest is the server's. */
  readonly language: HouseholdLanguage;
  readonly onAction: (id: string) => void;
}

/** The contracts' CardAction is already the shape CalmCard wants. */
const toCalmActions = (actions: readonly CardAction[]) => actions;

export function DoorCardView({ card, language, onAction }: DoorCardProps): React.JSX.Element {
  // A demo home's stand-in doorbell, said in a quiet line of its own: her sentence is the one a real ring brings.
  const standIn = card.standIn ? words(language)('door.standIn') : undefined;
  return (
    <View style={styles.lowerThird}>
      <TwoPhaseCard
        headline={card.line}
        detail={doorDetailText(card, language)}
        actions={toCalmActions(card.actions)}
        onAction={onAction}
        mediaSize={FRAME}
        compact
        childWords={[card.notice, standIn]}
        media={
          card.imageRef ? (
            <Image
              source={{ uri: card.imageRef }}
              style={styles.frame}
              resizeMode="cover"
              // The frame is the subject of the card, so it is described as
              // such. What is IN it is card.description, and that is announced
              // separately when and if it arrives.
              accessibilityLabel={words(language)('door.pictureLabel')}
            />
          ) : null
        }
      >
        {card.notice ? <CalmText accessibilityLiveRegion="polite">{card.notice}</CalmText> : null}
        {standIn ? <CalmText tone="dim">{standIn}</CalmText> : null}
      </TwoPhaseCard>
    </View>
  );
}

/**
 * 16:9, matching the doorbell's own frame, and just tall enough for the text
 * beside it: one line of headline and the two reserved lines of description.
 */
const FRAME = { width: 256, height: 144 } as const;

const styles = StyleSheet.create({
  // Anchored to the bottom, inside the 5% TV safe area. The programme keeps
  // the rest of the screen.
  lowerThird: {
    position: 'absolute',
    left: 48,
    right: 48,
    bottom: 32,
  },
  frame: {
    width: '100%',
    height: '100%',
  },
});
