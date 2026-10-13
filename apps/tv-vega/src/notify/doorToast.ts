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
 * would be an interruption (docs/WICK.md Part 5).
 *
 * The content is the shape react-native-kepler's own useToastKepler builds
 * (Libraries/Components/ToastKepler). Verified on the VVD 2026-10-11 — see
 * FRICTION.md FL-022 for what the platform accepts and what it silently
 * drops.
 */
import type { QueuedCard } from '@wick/contracts';

/**
 * https only: the system renderer fetches the icon itself and cannot read a
 * file from this app's own assets.
 */
export const WICK_ICON_URL = 'https://rogerjeasy.github.io/wick/icons/light-126.png';

/** The interactive component's own URI — what the toast's button launches. */
const WICK_APP_URI = 'pkg://com.wick.tv.main';

/** The platform's long toast, in seconds (ToastKeplerDuration.LONG). */
const TOAST_SECONDS = 8;

/**
 * The notification manager refuses a notification over 4096 bytes
 * (`max-notification-payload`, /etc/notification-manager on the device).
 * Ring's picture address is signed, and long; it is sent once, and if the
 * toast would still be over the cap the words win and Wick's own mark is
 * shown instead.
 */
export const MAX_NOTIFICATION_BYTES = 4096;

/** NotificationManager's kind for a toast — the only kind a third-party app may post. */
const TOAST_KIND = 5;

export interface ToastContent {
  readonly mTitle: string;
  readonly mDescription: string;
  readonly mIconUri: string;
  readonly mTimeout: number;
  readonly mLaunchTargets: readonly { readonly appUri: string; readonly title: string; readonly iconUri: string }[];
  readonly mChannel: {
    readonly importance: { readonly importance: 'NORMAL' };
    readonly kind: { readonly kindDescriptor: number };
    /** The render template. Any other name is accepted and draws nothing. */
    readonly name: 'MenuToastRenderTemplate';
  };
}

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
    mLaunchTargets: [{ appUri: WICK_APP_URI, title: 'Open Wick', iconUri: 'not_used' }],
    mChannel: {
      importance: { importance: 'NORMAL' },
      kind: { kindDescriptor: TOAST_KIND },
      name: 'MenuToastRenderTemplate',
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
  post(content: ToastContent): Promise<unknown>;
}

async function platformNotificationManager(): Promise<NotificationManagerLike> {
  // Imported lazily for the same reason CardService imports the file system
  // lazily: looking a TurboModule up throws outside a Vega runtime.
  const { TurboModuleRegistry } = await import('@amazon-devices/keplerscript-turbomodule-api');
  return TurboModuleRegistry.getEnforcing('NotificationManager') as unknown as NotificationManagerLike;
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
