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
 * Two things about OK, both found on the emulator and neither in React
 * Native's TV guidance (FRICTION.md FL-028):
 *
 *   - A short press reaches JavaScript as the key coming up and nothing
 *     else: React Native sends no key-down unless a flag is set. So a
 *     key-up with no key-down before it is the whole press, and is said
 *     as one: down, then up. Saying only the down would leave the key
 *     "held" for ever — and two seconds later that was a hold.
 *   - A press that lasts is reported under another name: "longSelect"
 *     going down once Android notices the hold, and coming up when it is
 *     let go. It is OK all the same, and is said as OK.
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
  // A held OK: the same button under the name Android gives a long press.
  longSelect: 'select',
};

/** Android's KeyEvent.ACTION_DOWN and ACTION_UP. */
const KEY_DOWN = 0;
const KEY_UP = 1;
/** Vega's HWEvent: 0 is key down, the one the Vega app acts on; 1 is key up. */
const VEGA_KEY_DOWN = 0;
const VEGA_KEY_UP = 1;

/** The key as the Vega app names it. */
const vegaName = (type: string): string => VEGA_NAME[type] ?? type;

const NOTHING: readonly RemoteEvent[] = [];

/**
 * Turns Android's stream of key events into the one the Vega app expects:
 * for each press of a key its key-down, then its key-up, and nothing for
 * the rest — a key held down repeating, and focus moving, which React
 * Native reports through the same channel. One Android event becomes none,
 * one or two of these.
 *
 * Holds which keys are down, by their Vega names, so one is made per
 * television screen that listens (adapters/kepler.ts keeps it for the life
 * of the component).
 */
export function remoteKeyEvents(): (event: AndroidRemoteEvent | null | undefined) => readonly RemoteEvent[] {
  const down = new Set<string>();
  return (event) => {
    const type = event?.eventType;
    if (!type || type === 'focus' || type === 'blur') return NOTHING;
    const key = vegaName(type);
    const keyDown: RemoteEvent = { eventType: key, eventKeyAction: VEGA_KEY_DOWN };
    const keyUp: RemoteEvent = { eventType: key, eventKeyAction: VEGA_KEY_UP };

    if (event.eventKeyAction === KEY_UP) {
      // The end of a press already said — or the whole of one whose start
      // never arrived, said whole so that no key is ever left down.
      return down.delete(key) ? [keyUp] : [keyDown, keyUp];
    }
    if (event.eventKeyAction === KEY_DOWN) {
      if (down.has(key)) return NOTHING; // held: Android repeats the key going down, and renames it
      down.add(key);
      return [keyDown];
    }
    // No action given: the event is the whole press.
    return [keyDown, keyUp];
  };
}
