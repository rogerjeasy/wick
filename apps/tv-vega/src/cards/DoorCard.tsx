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
 * Lower third, never full screen: it must not cover, pause or silence whatever
 * the resident is already watching.
 */
import * as React from 'react';
import { Image, StyleSheet, View } from '@amazon-devices/react-native-kepler';
import type { CardAction, DoorCard as DoorCardModel } from '@wick/contracts';
import { TwoPhaseCard, safe } from '@wick/vega-calm-ui';

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
        detail={card.description}
        actions={toCalmActions(card.actions)}
        onAction={onAction}
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

const styles = StyleSheet.create({
  // Lower third. The programme keeps the rest of the screen.
  lowerThird: {
    position: 'absolute',
    left: 64,
    right: 64,
    bottom: 64,
  },
  frame: {
    width: '100%',
    height: 320,
    borderRadius: 12,
    backgroundColor: safe.ground,
  },
});
