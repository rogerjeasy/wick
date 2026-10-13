/**
 * A remote's key press, renamed from what React Native delivers on Android
 * TV and Fire OS to what the Vega app listens for
 * (apps/tv-vega/src/watch/remoteKeys.ts).
 *
 * The buttons are the same; the names are not. Android spells the media keys
 * in camel case ("playPause", "fastForward") where Vega's are lower case
 * ("playpause", "skip_forward"). The D-pad and "select" already agree.
 *
 * And a press is acted on once. Android reports a key going down and coming
 * back up as two events, but not reliably both: on the Android TV emulator
 * play/pause arrives only as the key coming up. So neither half can be the
 * one to wait for. Whichever arrives first is the press, and the other half,
 * if it comes, is not a second one.
 *
 * The key coming up after its press is passed on as what it is — Vega's
 * own "key up" — because that is what tells a hold on OK from a press
 * (apps/tv-vega/src/watch/hold.ts). The Vega app acts on key down only
 * (remoteKeys.ts), so nothing takes it for a second press.
 *
 * No React and no native module here, so it is tested as plain code.
 */
export interface RemoteEvent {
  readonly eventType: string;
  readonly eventKeyAction?: number;
}

export interface AndroidRemoteEvent {
  readonly eventType?: string | null | undefined;
  readonly eventKeyAction?: number | null | undefined;
}

const VEGA_NAME: Readonly<Record<string, string>> = {
  playPause: 'playpause',
  fastForward: 'skip_forward',
  rewind: 'skip_backward',
};

/** Android's KeyEvent.ACTION_DOWN and ACTION_UP. */
const KEY_DOWN = 0;
const KEY_UP = 1;
/** Vega's HWEvent: 0 is key down, the one the Vega app acts on; 1 is key up. */
const VEGA_KEY_DOWN = 0;
const VEGA_KEY_UP = 1;

/** The event with the name and shape the Vega app expects. */
function renamed(type: string, action: number = VEGA_KEY_DOWN): RemoteEvent {
  return { eventType: VEGA_NAME[type] ?? type, eventKeyAction: action };
}

/**
 * Turns Android's stream of key events into presses: one key-down out for
 * each press of a key, as the Vega app expects it, then its key-up when
 * that comes, and nothing for the rest — a key held down repeating, and
 * focus moving, which React Native reports through the same channel.
 *
 * Holds which keys are down, so one is made per television screen that
 * listens (adapters/kepler.ts keeps it for the life of the component).
 */
export function remotePresses(): (event: AndroidRemoteEvent | null | undefined) => RemoteEvent | undefined {
  const down = new Set<string>();
  return (event) => {
    const type = event?.eventType;
    if (!type || type === 'focus' || type === 'blur') return undefined;

    if (event.eventKeyAction === KEY_UP) {
      // The end of a press already acted on, said as the key coming up —
      // or the whole of one whose start never arrived.
      return down.delete(type) ? renamed(type, VEGA_KEY_UP) : renamed(type);
    }
    if (event.eventKeyAction === KEY_DOWN) {
      if (down.has(type)) return undefined; // held: Android repeats the key going down
      down.add(type);
      return renamed(type);
    }
    // No action given: the event is the press.
    return renamed(type);
  };
}
