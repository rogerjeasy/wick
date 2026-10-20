/**
 * What the remote does while a programme is playing.
 *
 * Pure, so it is tested without a television: WatchScreen.tsx hands every
 * `useTVEventHandler` event here and does what comes back.
 *
 * OK and the arrows belong to a card when one is on screen — the card's own
 * buttons have focus, and a press meant for "Thank you" must not also pause
 * the programme. The dedicated media keys always mean the programme —
 * with one exception.
 *
 * Read to me (packages/contracts/src/speech.ts): over a card that can be
 * read aloud, Play is the card's. It asks for the card to be read, and on
 * the door's card or a card on the home screen it stops the reading again.
 * The app says when (`playReads`); when it does not say, Play is the
 * programme's exactly as it always was.
 *
 * Over a card, Play is always the card's (docs/design/DESIGN.md §6): it
 * reads the card aloud, and the next Play stops the reading. It never
 * moves the film, even over a note that is holding the film — one key, one
 * meaning. The film goes on when she answers the card or puts it aside
 * with Back (break/BreakController.ts), never because Play was pressed a
 * second time.
 *
 * A key that is only Pause never asks for a reading. It stops one that is
 * under way and does nothing else then; otherwise it is the programme's.
 */
export type WatchCommand = 'toggle' | 'forward' | 'back';
/** What a key does to a reading: Play asks for one or stops it; `stop` only ever ends one, and does nothing when there is none. */
export type ReadCommand = 'toggle' | 'stop';

/** What the app knows when a key arrives. */
export interface KeyContext {
  /** A card is on screen: OK and the arrows are its buttons'. */
  readonly cardVisible: boolean;
  /** Play is that card's for this press (playIsTheCards). When the app does not say, it is the programme's. */
  readonly playReads?: boolean | undefined;
  /** A reading has been asked for and is not over. */
  readonly reading?: boolean | undefined;
}

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

/**
 * Whose the next Play is: the card's whenever a card that can be read is on
 * screen, however often Play has been pressed and whether or not the card
 * is holding a film. `holdsFilm` and `askedFor` are still taken, so the two
 * televisions that ask can keep asking, and say nothing now: Play over a
 * card used to give the film back on its second press, which made one key
 * mean two things on one screen.
 */
export function playIsTheCards(at: { readonly card: string | undefined; readonly holdsFilm: boolean; readonly askedFor: string | null }): boolean {
  return at.card !== undefined;
}

/**
 * Where one press of Play, Play/Pause or Pause goes: to the reading, to the
 * programme, or — carrying on — to both. The media session's Play/Pause
 * command goes the same way (mediaSession.ts).
 */
export function playGoesTo(key: string, context: KeyContext): { readonly reader: ReadCommand | undefined; readonly film: boolean } {
  const reading = context.reading === true;
  // Only Pause: it stops a reading and nothing else; with none under way it is the programme's, as before.
  if (key === 'pause') return reading ? { reader: 'stop', film: false } : { reader: undefined, film: true };
  if (context.cardVisible && context.playReads === true) return { reader: 'toggle', film: false };
  // The programme's, as it always was. Carrying on with the film ends a reading at once.
  return { reader: context.cardVisible && reading ? 'stop' : undefined, film: true };
}

export function watchCommand(event: RemoteEventLike, context: KeyContext): WatchCommand | undefined {
  if (event.eventKeyAction !== undefined && event.eventKeyAction !== KEY_DOWN) return undefined;
  const media = own(MEDIA_KEYS, event.eventType);
  if (media === 'toggle') return playGoesTo(event.eventType, context).film ? media : undefined;
  if (media) return media;
  if (context.cardVisible) return undefined;
  return own(DPAD_KEYS, event.eventType);
}

/**
 * What a key does to the reading of the card on screen — nothing at all
 * when no card is. Acted on once for a press, as the programme's keys are:
 * on the key going down, or on an event that is the whole press.
 */
export function readCommand(event: RemoteEventLike, context: KeyContext): ReadCommand | undefined {
  if (!context.cardVisible) return undefined;
  if (event.eventKeyAction !== undefined && event.eventKeyAction !== KEY_DOWN) return undefined;
  if (own(MEDIA_KEYS, event.eventType) !== 'toggle') return undefined;
  return playGoesTo(event.eventType, context).reader;
}

/** A table's own entry: a key the remote names "constructor" is not one. */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** Where one skip lands: a skip key's thirty seconds, or the step the media session asks for (mediaSession.ts). */
export function seekTarget(positionMs: number, direction: 'forward' | 'back', durationMs: number, stepMs: number = SEEK_STEP_MS): number {
  if (direction === 'back') return Math.max(0, positionMs - stepMs);
  const target = positionMs + stepMs;
  return durationMs > 0 ? Math.min(target, durationMs - END_GUARD_MS) : target;
}
