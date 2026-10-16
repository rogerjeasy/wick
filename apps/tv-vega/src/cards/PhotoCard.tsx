/**
 * A picture someone in the family sent (packages/contracts/src/mantel.ts).
 * It waits for a natural break like any note (INV-5), and has two answers
 * that both put it away (cardActions.ts): "Keep it", which stands it on her
 * mantelpiece, and "Thank you". The family is told the same one thing
 * whichever she presses.
 *
 * The server wrote the headline, the two buttons and — when "Keep it" found
 * the mantelpiece full — the notice; this only renders them. The picture
 * carries no words of the family's. What is the television's own is the
 * sentence in the picture's place when it cannot be shown, and what the
 * screen reader calls it (words/words.ts).
 *
 * The picture is beside the words, as large as the card allows: see
 * photoLayout.ts for the numbers and what holds them. It is shown whole,
 * never cropped (mantel/Picture.tsx). If its address is missing or no
 * longer answers — one lives an hour — the card says so calmly in its
 * place, and both buttons still work. And it tells the app, which asks
 * the server for its cards again: the server mints a new address each time
 * it sends this one (mantel/mantel.ts pictureRefresher).
 */
import * as React from 'react';
import { StyleSheet, View } from '@amazon-devices/react-native-kepler';
import type { HouseholdLanguage, PhotoCard as PhotoCardModel } from '@wick/contracts';
import { CalmCard, CalmText, assertCardFits } from '@wick/vega-calm-ui';
import { Picture } from '../mantel/Picture.js';
import { PHOTO_BOX, PHOTO_CARD_COMPACT, PHOTO_NOTICE_LINES, pictureAddress } from './photoLayout.js';

export interface PhotoCardProps {
  readonly card: PhotoCardModel;
  /** For the television's own two sentences; everything else on the card is the server's. */
  readonly language: HouseholdLanguage;
  readonly onAction: (id: string) => void;
  /** The picture cannot be shown: the card has no address for it, or the address did not answer. */
  readonly onPictureFailed?: (() => void) | undefined;
}

export function PhotoCardView({ card, language, onAction, onPictureFailed }: PhotoCardProps): React.JSX.Element {
  // Throws before anything reaches the screen: a picture this tall and both buttons must fit it.
  assertCardFits({ compact: PHOTO_CARD_COMPACT, mediaHeightDp: PHOTO_BOX.height });

  const uri = pictureAddress(card.photoUrl);
  // No address at all is the same thing to the app as one that did not answer.
  React.useEffect(() => {
    if (uri === undefined) onPictureFailed?.();
  }, [uri, onPictureFailed]);

  return (
    <CalmCard
      headline={card.headline}
      actions={card.actions}
      onAction={onAction}
      compact={PHOTO_CARD_COMPACT}
      mediaSize={PHOTO_BOX}
      childWords={[card.notice]}
      media={
        <View style={styles.box}>
          <Picture uri={uri} fromName={card.fromName} language={language} onFailed={onPictureFailed} />
        </View>
      }
    >
      {/* Her mantelpiece is full: said under the headline, as the door card says what a press led to. */}
      {card.notice ? (
        <CalmText numberOfLines={PHOTO_NOTICE_LINES} accessibilityLiveRegion="polite">
          {card.notice}
        </CalmText>
      ) : null}
    </CalmCard>
  );
}

const styles = StyleSheet.create({
  box: {
    width: PHOTO_BOX.width,
    height: PHOTO_BOX.height,
  },
});
