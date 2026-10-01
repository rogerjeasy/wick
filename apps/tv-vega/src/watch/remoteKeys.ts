/**
 * What the remote does while a programme is playing.
 *
 * Pure, so it is tested without a television: WatchScreen.tsx hands every
 * `useTVEventHandler` event here and does what comes back.
 *
 * OK and the arrows belong to a card when one is on screen — the card's own
 * buttons have focus, and a press meant for "Thank you" must not also pause
 * the programme. The dedicated media keys always mean the programme.
 */
export type WatchCommand = 'toggle' | 'forward' | 'back';

/** One press of a skip key. */
export const SEEK_STEP_MS = 30_000;
/** A forward seek stops this far short of the end, so the programme ends by playing. */
const END_GUARD_MS = 1_000;
/** kepler's HWEvent: 0 is key down, 1 is key up. */
const KEY_DOWN = 0;

export interface RemoteEventLike {
  readonly eventType: string;
  readonly eventKeyAction?: number;
}

/**
 * Both spellings of each key. The SDK's own HWEvent documents "playpause",
 * "select", "skip_forward" and "skip_backward"; the Vega Virtual Device
 * sends "play", "enter", "forward" and "rewind" for the same buttons
 * (FRICTION.md FL-021). A remote that does nothing is the worst outcome
 * here, so each name is accepted.
 */
const MEDIA_KEYS: Readonly<Record<string, WatchCommand>> = {
  playpause: 'toggle',
  play: 'toggle',
  pause: 'toggle',
  skip_forward: 'forward',
  forward: 'forward',
  skip_backward: 'back',
  rewind: 'back',
};

const DPAD_KEYS: Readonly<Record<string, WatchCommand>> = {
  select: 'toggle',
  enter: 'toggle',
  right: 'forward',
  left: 'back',
};

export function watchCommand(event: RemoteEventLike, context: { readonly cardVisible: boolean }): WatchCommand | undefined {
  if (event.eventKeyAction !== undefined && event.eventKeyAction !== KEY_DOWN) return undefined;
  const media = MEDIA_KEYS[event.eventType];
  if (media) return media;
  if (context.cardVisible) return undefined;
  return DPAD_KEYS[event.eventType];
}

export function seekTarget(positionMs: number, direction: 'forward' | 'back', durationMs: number): number {
  if (direction === 'back') return Math.max(0, positionMs - SEEK_STEP_MS);
  const target = positionMs + SEEK_STEP_MS;
  return durationMs > 0 ? Math.min(target, durationMs - END_GUARD_MS) : target;
}
