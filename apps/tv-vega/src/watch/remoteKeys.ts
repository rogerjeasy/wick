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
 * And over a note that is holding the film it is the card's once. The
 * first Play reads the note; the next is her way back to the film, as Play
 * there always was — the film goes on, the note is put away
 * (break/BreakController.ts), and a reading still under way ends at once.
 * `playIsTheCards` is that rule.
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
 * Whose the next Play is: the card's, or the programme's.
 *
 * The card's while a card that can be read is on screen (`card`) — always
 * on the home screen and over a film the card does not hold, which is only
 * ever the door's. Over a film the card is holding it is the card's once:
 * when Play has already asked for this showing of this card (`askedFor`),
 * the next Play carries on with the film. It does so whether that reading
 * is still going, has ended, or never started — she must never have to
 * press twice to get back to her film because of a reading that did not
 * happen.
 *
 * `askedFor` is the app's to keep, and to forget when the card leaves the
 * screen: another card, or the same one shown again later, starts with
 * reading again.
 */
export function playIsTheCards(at: { readonly card: string | undefined; readonly holdsFilm: boolean; readonly askedFor: string | null }): boolean {
  if (at.card === undefined) return false;
  return !(at.holdsFilm && at.askedFor === at.card);
}

/** Where one press of Play, Play/Pause or Pause goes: to the reading, to the programme, or — carrying on — to both. */
function playGoesTo(key: string, context: KeyContext): { readonly reader: ReadCommand | undefined; readonly film: boolean } {
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

export function seekTarget(positionMs: number, direction: 'forward' | 'back', durationMs: number): number {
  if (direction === 'back') return Math.max(0, positionMs - SEEK_STEP_MS);
  const target = positionMs + SEEK_STEP_MS;
  return durationMs > 0 ? Math.min(target, durationMs - END_GUARD_MS) : target;
}
