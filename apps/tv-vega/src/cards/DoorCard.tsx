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
 *   - The middle button is absent when the doorbell reports no Chime Controls.
 *     The agent decides that from the live capability payload; this component
 *     simply renders however many actions it is given.
 *
 * The detail slot can also carry M4's schedule match ("This looks like
 * Maria — expected around now"), available from Phase 1, before the vision
 * description ever patches in — see doorDetail.ts for the priority between
 * them.
 *
 * Bottom of the screen, never full screen: it must not cover, pause or
 * silence whatever the resident is already watching.
 *
 * Sized for what the television actually reports — 960x540dp at 1080p, not
 * 1920x1080. At the design system's 48pt headline / 32pt body floor, the
 * earlier stacked layout (a 320dp frame above the text) ran off the top of
 * the screen on the VVD. The frame now sits in a reserved 16:9 box beside
 * the text, so the card fits and the picture arriving moves nothing.
 */
import * as React from 'react';
import { Image, StyleSheet, View } from '@amazon-devices/react-native-kepler';
import type { CardAction, DoorCard as DoorCardModel } from '@wick/contracts';
import { TwoPhaseCard } from '@wick/vega-calm-ui';
import { doorDetailText } from './doorDetail.js';

export interface DoorCardProps {
  readonly card: DoorCardModel;
  readonly onAction: (id: string) => void;
}

/** The contracts' CardAction is already the shape CalmCard wants. */
const toCalmActions = (actions: readonly CardAction[]) => actions;

export function DoorCardView({ card, onAction }: DoorCardProps): React.JSX.Element {
  return (
    <View style={styles.lowerThird}>
      <TwoPhaseCard
        headline={card.line}
        detail={doorDetailText(card)}
        actions={toCalmActions(card.actions)}
        onAction={onAction}
        mediaSize={FRAME}
        media={
          card.imageRef ? (
            <Image
              source={{ uri: card.imageRef }}
              style={styles.frame}
              resizeMode="cover"
              // The frame is the subject of the card, so it is described as
              // such. What is IN it is card.description, and that is announced
              // separately when and if it arrives.
              accessibilityLabel="Picture from the front door camera"
            />
          ) : null
        }
      />
    </View>
  );
}

/** 16:9, matching the doorbell's own frame. */
const FRAME = { width: 288, height: 162 } as const;

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
