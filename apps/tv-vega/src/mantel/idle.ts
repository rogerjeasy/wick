/**
 * The idle screen (packages/contracts/src/mantel.ts): when the home screen
 * has sat untouched for a few minutes, the pictures she has kept fill it,
 * one at a time, slowly, until any key is pressed.
 *
 * It makes nothing disappear and delays nothing. It is only ever there when
 * the home screen is in front with no card showing, nothing playing and
 * nothing waiting that is hers to answer; the one-second look that picks
 * cards goes on exactly as before underneath it, and the moment a card is
 * showable — the door, or a note — the idle screen is gone and the card is
 * shown by the ordinary rules.
 *
 * Any key ends it, and that key press does nothing else. The home screen is
 * still underneath, with its focus where it was, but out of the remote's
 * reach (HomeScreen's `cardVisible`) — and it stays out of reach until the
 * key that ended the idle screen has come up again. A television gives a
 * key coming up to whatever has the focus, and a film tile takes OK coming
 * up as a press (the same thing home/reach.ts guards against): bringing
 * the home screen back on the key going down would start the film under
 * her thumb. So there are three states — off, on, and ending — and the
 * home screen is hers again only in the first.
 *
 * Pure: `now` is always passed in, and the keys are given as they arrive
 * (ResidentApp.tsx, from `useTVEventHandler`). It only ever listens to
 * them; holding OK for Sarah is untouched (watch/hold.ts, and the tiles'
 * own long press on the home screen).
 */
import { MANTEL_EACH_FOR_MS, MANTEL_IDLE_AFTER_MS, type HomeState, type MantelItem } from '@wick/contracts';
import type { Mantel } from '../headless/QueueStore.js';
import { isOkKey } from '../watch/hold.js';
import type { RemoteEventLike } from '../watch/remoteKeys.js';
import { isFresh, offersMantel, shouldAsk } from './mantel.js';

/** kepler's HWEvent: 0 is key down, 1 is key up. */
const KEY_DOWN = 0;
const KEY_UP = 1;

/**
 * How long the home screen stays out of reach waiting for OK to come up,
 * on a remote that never says it did: longer than any hold, as home/reach.ts
 * allows for the same reason. The worst this costs is one press made again.
 */
export const IDLE_OK_GUARD_MS = 10_000;
/** For any other key. Its coming up presses nothing, so this is only about not leaving the home screen dead. */
export const IDLE_KEY_GUARD_MS = 1_000;

/** What the home screen is doing, as the one-second look finds it. */
export interface HomeNow {
  /** Wick is on screen. */
  readonly foreground: boolean;
  /** A film is on screen — playing or paused. */
  readonly watching: boolean;
  /** She has the mantelpiece open. */
  readonly mantelOpen: boolean;
  /** The door camera is open. */
  readonly liveOpen: boolean;
  /** A card is on screen, or would be now. */
  readonly cardShowing: boolean;
  /** Something waits in the home screen's row that is hers to answer. */
  readonly waiting: boolean;
  /**
   * The platform's screen reader (VoiceView) is on. Then her pictures never
   * fill the screen: a slideshow is moving content, and the reader would be
   * talking over pictures that change under it. Absent is off.
   */
  readonly screenReader?: boolean | undefined;
  readonly home: HomeState;
}

/** Whether the home screen is in front with nothing on it but the films — and she has pictures to show. */
export function homeIsQuiet(at: HomeNow): boolean {
  return at.foreground && !at.watching && !at.mantelOpen && !at.liveOpen && !at.cardShowing && !at.waiting && at.screenReader !== true && offersMantel(at.home);
}

/**
 * Whether her pictures may fill the screen now: the home screen is quiet,
 * and has been since `lastActiveAt` — the last key press, or the last
 * moment it was not quiet — for the contract's few minutes.
 */
export function idleDue(at: HomeNow & { readonly now: number; readonly lastActiveAt: number }): boolean {
  return homeIsQuiet(at) && at.now - at.lastActiveAt >= MANTEL_IDLE_AFTER_MS;
}

/** The pictures the idle screen may use: what the server answered, while the addresses are good, less any that did not load. */
export function idleShows(mantel: Mantel | undefined, failed: readonly string[], now: number): readonly MantelItem[] {
  if (!isFresh(mantel, now)) return [];
  return mantel.items.filter((item) => !failed.includes(item.photoId));
}

/** Which picture is up: each for the contract's twenty seconds, in order, and round again. */
export function idlePicture(items: readonly MantelItem[], startedAt: number, now: number): MantelItem | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(Math.max(0, now - startedAt) / MANTEL_EACH_FOR_MS) % items.length];
}

export type Idle =
  | { readonly phase: 'off' }
  /** Her pictures are on screen. */
  | { readonly phase: 'on'; readonly startedAt: number }
  /** A key ended it: the home screen shows again, and is out of reach until that key has come up. */
  | { readonly phase: 'ending'; readonly key: string; readonly at: number };

export const IDLE_OFF: Idle = { phase: 'off' };

/** Whether the home screen is out of the remote's reach: while the idle screen is on, and until the key that ended it is up. */
export const blocksHome = (idle: Idle): boolean => idle.phase !== 'off';

const sameKey = (a: string, b: string): boolean => a === b || (isOkKey(a) && isOkKey(b));

/** A key event, as it arrives. While the idle screen is off this does nothing at all. */
export function idleOnKey(idle: Idle, event: RemoteEventLike, now: number): Idle {
  if (idle.phase === 'off') return idle;
  // A press that arrives whole — no halves given — is over as it arrives.
  if (event.eventKeyAction !== KEY_DOWN && event.eventKeyAction !== KEY_UP) return IDLE_OFF;

  if (idle.phase === 'on') {
    // A key coming up with no going down seen: the whole of a press, already given to the idle screen.
    return event.eventKeyAction === KEY_UP ? IDLE_OFF : { phase: 'ending', key: event.eventType, at: now };
  }
  if (event.eventKeyAction === KEY_UP) return sameKey(event.eventType, idle.key) ? IDLE_OFF : idle;
  // Held, and repeating.
  if (sameKey(event.eventType, idle.key)) return idle;
  // Another key: the first must be up. This one was pressed at a screen that could not answer it, and is taken too.
  return { phase: 'ending', key: event.eventType, at: now };
}

/** Back, which arrives by itself and not as a key with two halves. It ends the idle screen and goes no further. */
export function idleOnBack(idle: Idle): { readonly idle: Idle; readonly consumed: boolean } {
  return idle.phase === 'off' ? { idle, consumed: false } : { idle: IDLE_OFF, consumed: true };
}

/** The one-second look: turns it on when it is due and there is something to show, and off the moment it is not. */
export function idleOnLook(idle: Idle, look: { readonly due: boolean; readonly pictures: number; readonly now: number }): Idle {
  if (idle.phase === 'ending') {
    return look.now - idle.at >= (isOkKey(idle.key) ? IDLE_OK_GUARD_MS : IDLE_KEY_GUARD_MS) ? IDLE_OFF : idle;
  }
  const show = look.due && look.pictures > 0;
  if (idle.phase === 'on') return show ? idle : IDLE_OFF;
  return show ? { phase: 'on', startedAt: look.now } : idle;
}

/** What the one-second look comes to, for the idle screen. */
export interface IdleLook {
  readonly idle: Idle;
  /** What the idle minutes are now counted from: the look moves it on whenever the home screen is not quiet. */
  readonly lastActiveAt: number;
  /** Ask the server for her mantelpiece now. */
  readonly ask: boolean;
  /** The picture to have up, while the idle screen is on. */
  readonly picture: MantelItem | undefined;
}

/**
 * The whole of what the look decides here, in one place — given the home
 * screen as the look found it *after* picking cards exactly as it would
 * with no mantelpiece at all. It never says anything about a card: only
 * whether her pictures may fill a home screen that has nothing else on it.
 *
 * Her mantelpiece is asked for when the idle screen is due or she has it
 * open, and again before the addresses run out (mantel.ts shouldAsk); the
 * idle screen does not come on until there is something to show.
 */
export function lookAtIdle(
  at: HomeNow & {
    readonly now: number;
    readonly idle: Idle;
    readonly lastActiveAt: number;
    readonly mantel: Mantel | undefined;
    /** When the server was last asked for her mantelpiece. */
    readonly askedAt: number | null;
    /** Pictures of this answer whose address did not load on the idle screen. */
    readonly failed: readonly string[];
  },
): IdleLook {
  const lastActiveAt = homeIsQuiet(at) ? at.lastActiveAt : at.now;
  const due = idleDue({ ...at, lastActiveAt });
  const ask = (due || at.mantelOpen) && shouldAsk({ mantel: at.mantel, askedAt: at.askedAt, now: at.now });
  const pictures = idleShows(at.mantel, at.failed, at.now);
  const idle = idleOnLook(at.idle, { due, pictures: pictures.length, now: at.now });
  return { idle, lastActiveAt, ask, picture: idle.phase === 'on' ? idlePicture(pictures, idle.startedAt, at.now) : undefined };
}
