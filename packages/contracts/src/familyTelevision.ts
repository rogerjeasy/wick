/**
 * Sarah's television — Wick on a family member's own television.
 *
 * The same app, connected by a member as *theirs* (edge-device pair-claim
 * with `as: 'family'`). It is the family app with a remote and a big
 * screen: it shows that one member what they may already read and lets
 * them give the answers they may already give — and it is not the
 * resident's television in any sense that matters.
 *
 * Kept apart where it matters:
 *
 *   - Its row is `HH#<household>` / `FTV#<deviceId>`, never `DEV#…`, which
 *     is what makes a television the resident's. So nothing meant for the
 *     resident is ever sent to it, and no press on it counts as hers.
 *   - Its token carries `kind: 'family'` and the member's `userId`. It is
 *     not used on the resident's card channel at all. The television asks
 *     the Wick server, over HTTPS, for its home screen and tells it of a
 *     press (mcp-server familyTelevision.ts); the server answers with the
 *     same gated logic as the family's tools, as that one member, checking
 *     the circle again on every call (INV-9).
 *
 * The television renders and never decides: the server writes every word
 * and every button, as it does for the resident's cards.
 */
import type { CardAction } from './card.js';

export const FAMILY_TV_KIND = 'family';
/**
 * The one narrower token a family television holds: its background service's, good for asking what is
 * waiting (`GET /tv/waiting`) and for nothing else the Wick server offers.
 */
export const FAMILY_TV_WAITING_SCOPE = 'waiting';
export const FAMILY_TV_SK_PREFIX = 'FTV#';

/** Where the pairing key's public half is published for the Wick server (edge-device family-television.mjs). */
export const PAIRING_PUBLIC_KEY_ROW = { pk: 'CONFIG#pairing', sk: 'PUBLIC_KEY' } as const;

/** What a family television's token says, beside when it expires. */
export interface FamilyTelevisionClaims {
  readonly deviceId: string;
  readonly householdId: string;
  readonly kind: typeof FAMILY_TV_KIND;
  /** The member who connected it: everything it is shown is theirs to read. */
  readonly userId: string;
  /** Present on the background service's token only: what that token is good for. */
  readonly scope?: typeof FAMILY_TV_WAITING_SCOPE;
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Whether verified claims are a family television's. The resident's own token has no kind and no member. */
export function isFamilyTelevisionToken(claims: unknown): claims is FamilyTelevisionClaims {
  if (typeof claims !== 'object' || claims === null) return false;
  const { deviceId, householdId, kind, userId } = claims as Record<string, unknown>;
  return kind === FAMILY_TV_KIND && text(deviceId) && text(householdId) && text(userId);
}

/**
 * What a card on a family television can be about: her question from the
 * door, her asking to be rung, a film arranged with her (watch.ts), a wave
 * that came back, and her week once she has read it herself (INV-7).
 */
export const FAMILY_TV_CARD_KINDS = ['door_look', 'reach', 'watch', 'wave', 'week'] as const;
export type FamilyTvCardKind = (typeof FAMILY_TV_CARD_KINDS)[number];

const CARD_PREFIX = 'ftv-';
const REQUEST_ID = /^[A-Za-z0-9_-]+$/;

export function familyTvCardId(kind: FamilyTvCardKind, requestId: string): string {
  return `${CARD_PREFIX}${kind}-${requestId}`;
}

/** What a family television's card is about, from its id — or undefined for any other card. */
export function parseFamilyTvCardId(cardId: unknown): { readonly kind: FamilyTvCardKind; readonly requestId: string } | undefined {
  if (typeof cardId !== 'string' || !cardId.startsWith(CARD_PREFIX)) return undefined;
  const rest = cardId.slice(CARD_PREFIX.length);
  const kind = FAMILY_TV_CARD_KINDS.find((k) => rest.startsWith(`${k}-`));
  if (!kind) return undefined;
  const requestId = rest.slice(kind.length + 1);
  return REQUEST_ID.test(requestId) ? { kind, requestId } : undefined;
}

/**
 * Buttons the television answers itself. The server still writes them — the
 * words are its own — but pressing one sends nothing:
 *
 *   - `read`   opens the card's `pages`, one at a time;
 *   - `later`  puts the card away on this screen until it changes;
 *   - `seat`   opens the seat beside her film (FamilyTvSeat).
 *
 * Spelled so that no answer anybody can give is ever mistaken for one.
 */
export const FAMILY_TV_OWN_ACTIONS = { read: 'ftv-read', later: 'ftv-later', seat: 'ftv-seat' } as const;
export type FamilyTvOwnAction = (typeof FAMILY_TV_OWN_ACTIONS)[keyof typeof FAMILY_TV_OWN_ACTIONS];
const OWN_ACTIONS: readonly unknown[] = Object.values(FAMILY_TV_OWN_ACTIONS);
export const isFamilyTvOwnAction = (id: unknown): id is FamilyTvOwnAction => OWN_ACTIONS.includes(id);

/**
 * Presses a family television sends beside the answers to her questions
 * (DOOR_ANSWERS, REACH_ANSWERS, WATCH_ANSWERS — whose keys are the action):
 *
 *   - `sit`   on a `watch` card: sitting down to the film, as
 *             join_watch_together does. When it is done the television
 *             opens the seat.
 *   - `wave`  on FAMILY_TV_WAVE_CARD: a wave to her television.
 *   - `read`  on a `week` card, sent when the last page has been turned.
 *   - `seen`  on a `wave` card: the wave that came back has been seen.
 *
 * The last two are quiet: nothing is shown in answer, the card is simply
 * not there the next time the television asks.
 */
export const FAMILY_TV_PRESSES = { sit: 'sit', wave: 'wave', read: 'read', seen: 'seen' } as const;
const QUIET_PRESSES: readonly unknown[] = [FAMILY_TV_PRESSES.read, FAMILY_TV_PRESSES.seen];
export const isFamilyTvQuietPress = (action: unknown): boolean => QUIET_PRESSES.includes(action);

/** The card a new wave is pressed on. Not a wave that was sent: those have ids of their own. */
export const FAMILY_TV_WAVE_CARD = familyTvCardId('wave', 'new');

/**
 * One card on a family television. The server wrote all of it. `actions`
 * are the answers that can be given (never more than three); a card with
 * none only says how something stands.
 */
export interface FamilyTvCard {
  readonly id: string;
  readonly kind: FamilyTvCardKind;
  readonly headline: string;
  readonly detail?: string;
  /** The picture from the door, only while the resident's question is open (INV-3: it is Ring's address, stored nowhere). */
  readonly pictureUrl?: string;
  /**
   * Something to read, a screenful at a time — her week. Opened by the
   * card's `read` button, never shown unasked, and never more than a card's
   * worth of words to a page.
   */
  readonly pages?: readonly string[];
  readonly actions: readonly CardAction[];
}

/**
 * A wave: one button on the home screen, for whoever is in the room — the
 * grandchildren can press it. `cardId` and `label` are there when a wave
 * can be sent; `line` says how the last one stands ("Your wave is on
 * Margaret’s television."). It carries no words of the family's: what her
 * television says is Wick's own sentence, under the name of the member the
 * television belongs to, and it waits for a quiet moment like any note.
 */
export interface FamilyTvWave {
  readonly label: string;
  /** FAMILY_TV_WAVE_CARD while a wave can be sent; absent while one is still on her television. */
  readonly cardId?: string;
  readonly line?: string;
}

/** `GET /tv/home`: everything a family television shows. */
export interface FamilyTvHome {
  /** Whose home this television looks towards, by the name the member knows them by. */
  readonly residentName: string;
  /** The first name of the member this television belongs to. */
  readonly memberName: string;
  /**
   * Her light in the window, in one sentence — absent when she keeps the
   * shape of her day to herself. Asking for it is a look, and she is told.
   */
  readonly light?: { readonly lit: boolean; readonly line: string };
  /** What is waiting for this member, most pressing first. */
  readonly cards: readonly FamilyTvCard[];
  /** The wave button, for a member who may send one. */
  readonly wave?: FamilyTvWave;
  /** A demo home: its history is simulated, and the screen says so. */
  readonly simulated?: true;
}

/** `POST /tv/press`: the member's press on one of those cards. */
export interface FamilyTvPress {
  readonly cardId: string;
  readonly action: string;
}

/** What the television says back: one sentence, as it stands. */
export interface FamilyTvPressResult {
  readonly done: boolean;
  readonly say: string;
}

/**
 * `GET /tv/seat`: the seat beside her film, for the member who invited her
 * and has sat down — on this television or anywhere else. Absent for
 * everyone else and at every other time, in the same shape as there being
 * no film at all (watch.ts: where a film has got to is read back only to
 * the one person she said yes to).
 *
 * The television follows and never leads: it plays `stream` where
 * `playback` says her film is, stops where hers stops, and has no pause and
 * no skip of its own. Nobody reaches her remote.
 */
export interface FamilyTvSeat {
  /** The `watch` card of this film: what the answer at the end is pressed on. */
  readonly cardId: string;
  readonly film: string;
  /**
   * `waiting`: sat down, and she has not started the film. `watching`: her
   * film is being followed. `asked`: the credits have begun and the
   * question is open. `over`: it has ended, and `line` says how.
   */
  readonly state: 'waiting' | 'watching' | 'asked' | 'over';
  /** The screen in one sentence, as it stands. */
  readonly line: string;
  readonly stream?: { readonly url: string; readonly durationMs: number; readonly attribution: string };
  /** Where her film is, and how long ago the television said so. */
  readonly playback?: { readonly state: 'PLAYING' | 'PAUSED' | 'STOPPED' | 'WAITING'; readonly positionMs: number; readonly ageMs: number };
  /** At the credits: the one question, and the answers that can be given — an answer's key is the press. */
  readonly question?: string;
  readonly answers?: readonly CardAction[];
  readonly yourAnswer?: string;
  readonly theirAnswer?: string;
}

/** What `GET /tv/seat` answers. */
export interface FamilyTvSeatReply {
  readonly seat?: FamilyTvSeat;
}

/**
 * `GET /tv/waiting`: what a family television would say while its app is
 * off the screen — one sentence for each thing waiting for this member's
 * answer, and for a wave that has come back. It is asked by the
 * television's background service, not by a person looking, so it carries
 * nothing about her day and is never noted as a look: no light, no week.
 * `id` is the card's, so a television says each thing once.
 */
export interface FamilyTvWaiting {
  readonly waiting: readonly { readonly id: string; readonly line: string }[];
}

/** How often the seat asks where her film is: a pause of hers is followed within a breath. */
export const FAMILY_TV_SEAT_EVERY_MS = 2_000;

/** How often a family television off the screen asks whether anything waits. A doorstep question lasts five minutes. */
export const FAMILY_TV_WAITING_EVERY_MS = 20_000;

/** How often a family television on screen asks again. A doorstep question lasts five minutes; this keeps it well inside that. */
export const FAMILY_TV_LOOK_EVERY_MS = 8_000;
