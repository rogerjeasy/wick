/**
 * A remote's key press, renamed from what React Native delivers on Android
 * TV and Fire OS to what the Vega app listens for
 * (apps/tv-vega/src/watch/remoteKeys.ts).
 *
 * The buttons are the same; the names are not. Android spells the media keys
 * in camel case ("playPause", "fastForward") where Vega's are lower case
 * ("playpause", "skip_forward"). The D-pad and "select" already agree.
 *
 * Pure, so it is tested without a television.
 */
export interface RemoteEvent {
  readonly eventType: string;
  readonly eventKeyAction?: number;
}

const VEGA_NAME: Readonly<Record<string, string>> = {
  playPause: 'playpause',
  fastForward: 'skip_forward',
  rewind: 'skip_backward',
};

/** Android's KeyEvent.ACTION_UP. A press is acted on once, when the key goes down. */
const KEY_UP = 1;
/** Vega's HWEvent: 0 is key down. */
const VEGA_KEY_DOWN = 0;

/**
 * The event as the Vega app expects it, or nothing for one it should not
 * hear: a key coming back up (the press was already acted on), and focus
 * moving, which React Native reports through the same channel.
 */
export function toVegaEvent(
  event: { readonly eventType?: string | null | undefined; readonly eventKeyAction?: number | null | undefined } | null | undefined,
): RemoteEvent | undefined {
  const type = event?.eventType;
  if (!type || type === 'focus' || type === 'blur') return undefined;
  if (event.eventKeyAction === KEY_UP) return undefined;
  return { eventType: VEGA_NAME[type] ?? type, eventKeyAction: VEGA_KEY_DOWN };
}
