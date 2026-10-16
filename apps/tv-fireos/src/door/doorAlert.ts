/**
 * The door, outside Wick, on Fire OS — what the notification says, and
 * whether there is one at all.
 *
 * When another app is in front, Wick cannot draw its card. What it can do
 * is post an Android notification, which Fire OS shows as a heads-up at the
 * bottom of the screen and then keeps in its Notification Center. It has
 * one button, and choosing it, or the notification itself, brings Wick
 * forward to the card that is waiting there.
 *
 * DOOR cards only. A note from the family is DEFERRED: it waits for a
 * natural break and never interrupts, and a notification over somebody
 * else's programme would be an interruption (docs/WICK.md Part 5). Amazon
 * asks apps not to put up a heads-up while another app is in front; the
 * door is the one exception Wick makes, and the only one (FRICTION.md
 * FL-035).
 *
 * The same rule as the Vega toast (apps/tv-vega/src/notify/doorToast.ts),
 * with one difference: the service that posts this one runs in the app's
 * own process and reads the app's storage, so it knows her language. The
 * title and the description are the server's, and arrive in it already.
 *
 * Pure, and imports nothing of the platform.
 */
import { DOOR_CARD_TTL_MS, type HouseholdLanguage, type QueuedCard } from '@wick/contracts';
import { words } from '../../../tv-vega/src/words/words.js';

export interface DoorAlert {
  /** The card it points at: it is put up, changed and taken down by this. */
  readonly cardId: string;
  readonly title: string;
  readonly text: string;
  /** The picture from the door, where there is one Android can fetch. */
  readonly pictureUrl?: string;
  /** The one button. */
  readonly openLabel: string;
  /**
   * How much longer the card it points at is live. The notification goes
   * with its card — the app lets a door card go at the same moment
   * (break/NaturalBreakEngine.ts) — so that "someone is at the door" is
   * never said once it is no longer true. Not a countdown: nothing is
   * shown counting.
   */
  readonly endsInMs: number;
}

/**
 * The notification for a card that came while Wick was not on screen, or
 * nothing if the card should wait. Built from the card as it stands, so the
 * same card gives a fuller notification once the door agent's description
 * and picture have come (transport/startCardChannel.ts announces it again
 * then, once).
 */
export function doorAlert(queued: QueuedCard, language: HouseholdLanguage, now: number): DoorAlert | undefined {
  const card = queued.card;
  if (card.type !== 'DOOR') return undefined;
  const endsInMs = (queued.expiresAt ?? queued.queuedAt + DOOR_CARD_TTL_MS) - now;
  if (endsInMs <= 0) return undefined;

  const say = words(language);
  const description = card.description?.trim();
  return {
    cardId: queued.id,
    title: card.line,
    text: description ? description : say('doorAlert.who'),
    ...(card.imageRef?.startsWith('https://') ? { pictureUrl: card.imageRef } : {}),
    openLabel: say('doorAlert.open'),
    endsInMs,
  };
}

/** Android's own number for Android 13, from which posting a notification is the person's to allow. */
const ASKS_TO_NOTIFY_FROM_SDK = 33;

/**
 * Whether to ask her, now, if Wick may put up notifications. Once, ever:
 * on Android 13 and later only (Fire OS 7 and 8 are Android 9 and 11, where
 * it is allowed when the app is installed), and never again once she has
 * answered — her no stands, and the door is then said only inside Wick.
 */
export function shouldAskToNotify(state: { readonly sdk: number; readonly granted: boolean; readonly askedBefore: boolean }): boolean {
  return state.sdk >= ASKS_TO_NOTIFY_FROM_SDK && !state.granted && !state.askedBefore;
}
