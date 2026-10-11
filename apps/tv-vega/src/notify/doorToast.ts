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
 * The notification manager caps one notification at 4096 bytes, and the
 * picture's address is sent twice. A signed address longer than this would
 * push the whole toast over the cap, so Wick's own mark is used instead.
 */
const MAX_PICTURE_URL_CHARS = 1024;

/** NotificationManager's kind for a toast — the only kind a third-party app may post. */
const TOAST_KIND = 5;

export interface ToastContent {
  readonly mTitle: string;
  readonly mDescription: string;
  readonly mIconUri: string;
  readonly mLargeIconUri: string;
  readonly mTimeout: number;
  readonly mLaunchTargets: readonly { readonly appUri: string; readonly title: string; readonly iconUri: string }[];
  readonly mChannel: {
    readonly importance: { readonly importance: 'NORMAL' };
    readonly kind: { readonly kindDescriptor: number };
    /** The render template. Any other name is accepted and draws nothing. */
    readonly name: 'MenuToastRenderTemplate';
  };
}

function picture(imageRef: string | undefined): string {
  if (!imageRef || !imageRef.startsWith('https://') || imageRef.length > MAX_PICTURE_URL_CHARS) return WICK_ICON_URL;
  return imageRef;
}

/** The toast for a card that arrived while Wick was not on screen, or nothing if the card should wait. */
export function doorToast(queued: QueuedCard): ToastContent | undefined {
  const card = queued.card;
  if (card.type !== 'DOOR') return undefined;
  const icon = picture(card.imageRef);
  return {
    mTitle: card.line,
    mDescription: card.description ?? 'Open Wick to see who it is.',
    mIconUri: icon,
    mLargeIconUri: icon,
    mTimeout: TOAST_SECONDS,
    mLaunchTargets: [{ appUri: WICK_APP_URI, title: 'Open Wick', iconUri: 'not_used' }],
    mChannel: {
      importance: { importance: 'NORMAL' },
      kind: { kindDescriptor: TOAST_KIND },
      name: 'MenuToastRenderTemplate',
    },
  };
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
