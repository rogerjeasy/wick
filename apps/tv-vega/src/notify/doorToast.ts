/**
 * The door, outside Wick. When another app is in front, Wick cannot draw a
 * card — Vega has no overlay for a third-party app. What it can do is ask
 * the system to show a toast: a small panel in the corner, over whatever is
 * on screen, with one button that brings Wick forward. The card itself,
 * with its picture and its buttons, is waiting there.
 *
 * Posted by the card service (headless/CardService.ts), the one part of
 * Wick that keeps running behind another app.
 *
 * DOOR cards only. A note from family is DEFERRED: it waits for a natural
 * break and never interrupts, and a toast over somebody else's programme
 * would be an interruption (docs/WICK.md §7).
 *
 * Two things here are this file's own words — "Open Wick" on the button,
 * and the line under the title when the door agent has not yet said who is
 * there — and they stay English when the household has chosen another
 * language (packages/contracts/src/language.ts). The service that posts
 * the toast is a process of its own: it holds the background connection,
 * which is never sent the `home` message that carries the language, and it
 * shares no storage with the app that could hand it over (FRICTION.md
 * FL-013). The title and the description are the server's, and come as it
 * sends them. So these two are not in the words table (words/words.ts),
 * and this directory is left out of the scan that holds the app to it.
 *
 * HOW IT IS POSTED. Vega's documented toast API is a React hook,
 * `useToastKepler` (react-native-kepler, "useToastKepler" in the React Native
 * for Vega API reference), and the card service is a headless process with no
 * React tree to call a hook from (FRICTION.md FL-044). So Wick does what that
 * hook does, with the hook's own parts: the content is built from the classes
 * it builds with (`ToastKind`, `AppLaunchTarget`), in its `NotificationContent`
 * type, and handed to the module it posts to (`NativeNotificationManager`) —
 * all three imported from react-native-kepler's ToastKepler directory, not
 * rebuilt here or looked up by name. When the SDK changes that contract, the
 * type check fails here instead of a toast that draws nothing. The hook's
 * choices are kept: a menu toast whenever there is a launch target, NORMAL
 * importance, and its LONG duration. Verified on the VVD — FL-022 says what
 * the platform accepts and what it silently drops.
 */
import type { QueuedCard } from '@wick/contracts';
import type {
  Importance,
  NotificationContent,
} from '@amazon-devices/react-native-kepler/Libraries/Components/ToastKepler/NativeNotificationManager';
import { AppLaunchTarget, ToastKind } from '@amazon-devices/react-native-kepler/Libraries/Components/ToastKepler/NotificationManagerUtils';

/**
 * https only: the system renderer fetches the icon itself and cannot read a
 * file from this app's own assets.
 */
export const WICK_ICON_URL = 'https://rogerjeasy.github.io/wick/icons/light-126.png';

/** The interactive component's own URI — what the toast's button launches. */
const WICK_APP_URI = 'pkg://com.wick.tv.main';

/** ToastKeplerDuration.LONG, in seconds: the hook's longer toast. */
const TOAST_SECONDS = 8;

/**
 * The hook's importance (Importance.IMPORTANCE_NORMAL) and template
 * (RenderTemplate.MENU_TOAST). Named as values here because the enums live in
 * the module that looks the TurboModule up as it loads, which cannot be
 * loaded outside a Vega runtime; the type keeps the importance honest.
 */
const NORMAL = 'NORMAL' as Importance;
const MENU_TOAST = 'MenuToastRenderTemplate';

/**
 * The notification manager refuses a notification over 4096 bytes
 * (`max-notification-payload`, /etc/notification-manager on the device).
 * Ring's picture address is signed, and long; it is sent once, and if the
 * toast would still be over the cap the words win and Wick's own mark is
 * shown instead.
 */
export const MAX_NOTIFICATION_BYTES = 4096;

/** A toast as the platform takes it: react-native-kepler's own `NotificationContent`. */
export type ToastContent = NotificationContent;

/**
 * How much of the cap a toast takes: its JSON, in UTF-8 bytes. The platform
 * serialises it its own way; JSON with every key name is the larger of the
 * two, so a toast that fits here fits there.
 */
export function notificationBytes(toast: ToastContent): number {
  const text = JSON.stringify(toast);
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // Counted by hand: the television's JavaScript engine has no TextEncoder.
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? ((i += 1), 4) : 3;
  }
  return bytes;
}

/**
 * A toast of Wick's, in the one shape the platform draws (FL-022): a title,
 * a line under it, an icon, and one button that brings Wick forward. Every
 * toast Wick posts is made here, so the channel name and the launch target
 * cannot drift between them (notify/waitingToast.ts is the other).
 */
export function wickToast(title: string, description: string, iconUri: string): ToastContent {
  return {
    mTitle: title,
    mDescription: description,
    mIconUri: iconUri,
    mTimeout: TOAST_SECONDS,
    // As the hook makes its launch target: the third argument is not used by the platform.
    mLaunchTargets: [new AppLaunchTarget(WICK_APP_URI, 'Open Wick', 'not_used')],
    mChannel: {
      importance: { importance: NORMAL },
      kind: new ToastKind(),
      // The render template is the channel's name. Any other name is accepted and draws nothing.
      name: MENU_TOAST,
    },
  };
}

/**
 * The toast for a door card that arrived while Wick was not on screen, or
 * nothing if the card should wait. Built from the card as it stands, so
 * the same card gives a fuller toast once its picture and description
 * have arrived (transport/startCardChannel.ts announces it again then).
 */
export function doorToast(queued: QueuedCard): ToastContent | undefined {
  const card = queued.card;
  if (card.type !== 'DOOR') return undefined;
  const withIcon = (icon: string): ToastContent => wickToast(card.line, card.description ?? 'Open Wick to see who it is.', icon);

  if (card.imageRef?.startsWith('https://')) {
    const withPicture = withIcon(card.imageRef);
    if (notificationBytes(withPicture) <= MAX_NOTIFICATION_BYTES) return withPicture;
  }
  return withIcon(WICK_ICON_URL);
}

export interface NotificationManagerLike {
  post(content: ToastContent): unknown;
}

async function platformNotificationManager(): Promise<NotificationManagerLike> {
  // The module useToastKepler posts to. Imported lazily for the same reason
  // CardService imports the file system lazily: it looks its TurboModule up
  // as it loads, which throws outside a Vega runtime.
  return (await import('@amazon-devices/react-native-kepler/Libraries/Components/ToastKepler/NativeNotificationManager')).default;
}

/**
 * Best effort, and silent: a toast that cannot be shown must not take the
 * card channel down with it. The card is already stored, and is on screen
 * the next time Wick is opened.
 */
export async function postToast(
  toast: ToastContent,
  manager: () => NotificationManagerLike | Promise<NotificationManagerLike> = platformNotificationManager,
): Promise<void> {
  try {
    await (await manager()).post(toast);
  } catch (err) {
    console.error('door_toast_failed', err);
  }
}
