/**
 * A note from the family, and Margaret's reply — one press, twice. M3.
 * See docs/WICK.md §4.3 (M3), §3.3 (the demo narrative).
 *
 * card.audioRef and card.fromPhotoRef are part of the full M3 spec but unused
 * by the only producer today — send_note_to_tv (§7.3) sets only `transcript`,
 * deliberately: model-drafted replies and recorded voice notes are "M3's full
 * build, sequenced later" (that file's own comment). Rendering an untested
 * play-then-reply sequence for a field nothing populates would be guessing at
 * a flow the product hasn't built yet (Principle 11). When audioRef lands for
 * real, this needs a play-first state machine — one button, then the three
 * replies — not four actions at once, which would trip CalmCard's 3-action
 * floor.
 */
import * as React from 'react';
import { Image, StyleSheet } from '@amazon-devices/react-native-kepler';
import type { MessageCard as MessageCardModel } from '@wick/contracts';
import { CalmCard, safe } from '@wick/vega-calm-ui';
import { replyActions } from './messageActions.js';

export interface MessageCardProps {
  readonly card: MessageCardModel;
  readonly onAction: (id: string) => void;
}

export function MessageCardView({ card, onAction }: MessageCardProps): React.JSX.Element {
  return (
    <CalmCard
      headline={`A message from ${card.fromName}.`}
      detail={card.transcript}
      actions={replyActions(card.suggestedReplies)}
      onAction={onAction}
    >
      {card.fromPhotoRef ? (
        <Image
          source={{ uri: card.fromPhotoRef }}
          style={styles.photo}
          resizeMode="cover"
          accessibilityLabel={`${card.fromName}'s photo`}
        />
      ) : null}
    </CalmCard>
  );
}

const styles = StyleSheet.create({
  photo: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: safe.ground,
    marginBottom: 8,
  },
});
