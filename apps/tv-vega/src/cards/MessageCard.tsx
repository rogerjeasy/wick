/**
 * A note from the family, and Margaret's reply — one press, twice. M3.
 * See docs/WICK.md §5.2 (M3), §4.2 (the demo narrative).
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
import type { HouseholdLanguage, MessageCard as MessageCardModel } from '@wick/contracts';
import { CalmCard, useCalmStyles, type CalmTheme } from '@wick/vega-calm-ui';
import { words } from '../words/words.js';
import { replyActions } from './messageActions.js';

export interface MessageCardProps {
  readonly card: MessageCardModel;
  /** For the sentence that says who it is from; the note and its replies are the server's, already in her language. */
  readonly language: HouseholdLanguage;
  readonly onAction: (id: string) => void;
}

export function MessageCardView({ card, language, onAction }: MessageCardProps): React.JSX.Element {
  const say = words(language);
  const styles = useCalmStyles(makeStyles);
  return (
    <CalmCard
      headline={say('message.headline', { name: card.fromName })}
      detail={card.transcript}
      actions={replyActions(card.suggestedReplies)}
      onAction={onAction}
      mediaSize={card.fromPhotoRef ? PHOTO : undefined}
      media={
        card.fromPhotoRef ? (
          <Image
            source={{ uri: card.fromPhotoRef }}
            style={styles.photo}
            resizeMode="cover"
            accessibilityLabel={say('message.photoLabel', { name: card.fromName })}
          />
        ) : null
      }
    />
  );
}

const PHOTO = { width: 96, height: 96 } as const;

const makeStyles = (t: CalmTheme) =>
  StyleSheet.create({
    photo: {
      ...PHOTO,
      borderRadius: 48,
      backgroundColor: t.palette.ground,
    },
  });
