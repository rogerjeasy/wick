/**
 * What a family member's own television shows, decided from the home the
 * Wick server gave (packages/contracts/src/familyTelevision.ts). Pure:
 * family/FamilyHome.tsx only draws what this says.
 *
 * The server wrote every word of every card and every button on it. What
 * is decided here is only the screen's own: the words around the cards,
 * which one card is in front, and what the one button of the television's
 * own — "All right" — does. It never sends anything: it puts a card that
 * only says how something stands away on this screen, or takes away the
 * sentence the server answered a press with.
 *
 * Three buttons the server writes are also the television's to answer
 * (FAMILY_TV_OWN_ACTIONS), and send nothing: "later" puts the card away
 * here, "read" opens its pages (reader.ts), "seat" opens the seat beside
 * her film (seat.ts). And two presses are quiet (isFamilyTvQuietPress): the
 * week read to its end, a wave seen — nothing is shown in answer; the
 * screen only asks for the home again.
 *
 * Nothing leaves the screen on a countdown. A card goes when the server
 * stops sending it or the member puts it away; a sentence goes when the
 * member presses "All right".
 */
import { FAMILY_TV_OWN_ACTIONS, FAMILY_TV_PRESSES, isFamilyTvOwnAction, isFamilyTvQuietPress, type CardAction, type FamilyTvCard, type FamilyTvHome, type FamilyTvPress } from '@wick/contracts';
import type { PressAnswer } from './familyClient.js';
import { openReader, type Reading } from './reader.js';

/** The television's own button. Its id is never sent to the server. */
export const ALL_RIGHT: CardAction = { id: 'wick-tv-all-right', label: 'All right', kind: 'primary' };

const NOTHING_WAITING = 'Nothing is waiting for you.';
/** A demo home says it is one wherever it is named (AGENTS.md, Data rules). */
const SIMULATED = 'This is a demo home. Its history is simulated.';

export function unreachableLine(residentName: string | undefined): string {
  return residentName ? `Wick cannot reach ${residentName}’s home just now.` : 'Wick cannot reach the home just now.';
}

/**
 * The screen before the first answer: there is no home to name yet, so the
 * heading is the name of the thing itself, and under it — once a look has
 * failed — that the home cannot be reached. Laid out as the home will be,
 * so the screen is never blank and never one stray sentence; and it claims
 * nothing it does not know.
 */
export function startingLines(unreachable: boolean): { readonly heading: string; readonly quiet: readonly string[] } {
  return { heading: 'Wick', quiet: unreachable ? [unreachableLine(undefined)] : [] };
}

export interface FamilyLines {
  /** Whose home this television looks towards. */
  readonly heading: string;
  /** Whose television it is — so nobody mistakes this for the resident's own screen. */
  readonly owner: string;
  /**
   * The quiet rows under those, top first. A card sits over the bottom of
   * the screen and may cover the last of them, so what must not be covered
   * comes first: that the home is a demo, then that it cannot be reached.
   * A row that has nothing to say is not there at all — her light least of
   * all, which must never leave a gap that hints it is being kept.
   */
  readonly quiet: readonly string[];
}

export function familyLines(home: FamilyTvHome, on: { readonly unreachable: boolean; readonly cardShown: boolean }): FamilyLines {
  return {
    heading: `${home.residentName}’s home`,
    owner: `This is ${home.memberName}’s television.`,
    quiet: [
      ...(home.simulated ? [SIMULATED] : []),
      ...(on.unreachable ? [unreachableLine(home.residentName)] : []),
      ...(home.light ? [home.light.line] : []),
      ...(on.cardShown ? [] : [NOTHING_WAITING]),
    ],
  };
}

/**
 * Cards put away on this screen: each one's id, and what it said when it
 * was put away. Kept for as long as the app runs — a card put away stays
 * away until what it SAYS changes, whether or not the server goes on
 * listing it in the meantime. Bounded: the newest PUT_AWAY_KEPT, in the
 * order they were put away.
 */
export type PutAway = Readonly<Record<string, string>>;

/** How many put-away cards are remembered. One put away longer ago than that many others may come back. */
export const PUT_AWAY_KEPT = 50;

/**
 * What a card says, for telling whether it has changed. Not the address of
 * its picture: that may be signed afresh on every look, and a card must not
 * come back for that.
 */
function saying(card: FamilyTvCard): string {
  return JSON.stringify([card.headline, card.detail ?? null, card.actions.map((a) => [a.id, a.label])]);
}

export function putAway(put: PutAway, card: FamilyTvCard): PutAway {
  // Taken out first, so that it is the newest however long ago it was first put away.
  const { [card.id]: _before, ...others } = put;
  const kept = Object.entries({ ...others, [card.id]: saying(card) });
  return Object.fromEntries(kept.slice(Math.max(0, kept.length - PUT_AWAY_KEPT)));
}

/**
 * What is still put away now that the server has answered again. A card it
 * lists with other words has changed: it is shown, and no longer
 * remembered. A card it does not list is remembered all the same — a
 * settled card the server stops listing for a while and then lists again
 * does not come back for that (seen on the Fire OS emulator, 2026-10-13).
 * The very same memory comes back when nothing in it changed.
 */
export function stillPutAway(put: PutAway, home: FamilyTvHome): PutAway {
  const changed = home.cards.filter((card) => put[card.id] !== undefined && put[card.id] !== saying(card)).map((card) => card.id);
  if (changed.length === 0) return put;
  return Object.fromEntries(Object.entries(put).filter(([id]) => !changed.includes(id)));
}

/** The card in front: the first the server sent that is not put away on this screen. */
function firstCard(home: FamilyTvHome | undefined, put: PutAway): FamilyTvCard | undefined {
  return home?.cards.find((c) => put[c.id] === undefined || put[c.id] !== saying(c));
}

export type Showing =
  | { readonly kind: 'nothing' }
  /** The server's answer to a press, in place of the card, until "All right". */
  | { readonly kind: 'said'; readonly key: string; readonly say: string; readonly actions: readonly CardAction[] }
  /** The first card not put away. `actions` are the server's, or "All right" alone for a card that has none. */
  | { readonly kind: 'card'; readonly key: string; readonly card: FamilyTvCard; readonly actions: readonly CardAction[] };

/**
 * The one card in front. `key` changes when the card is another one or its
 * buttons are, so the remote's focus is put on its first button again; it
 * does not change when only the words do, so focus stays where it was.
 */
export function showing(home: FamilyTvHome | undefined, put: PutAway, said: string | undefined): Showing {
  if (said) return { kind: 'said', key: `said:${said}`, say: said, actions: [ALL_RIGHT] };
  const card = firstCard(home, put);
  if (!card) return { kind: 'nothing' };
  const actions = card.actions.length > 0 ? card.actions : [ALL_RIGHT];
  return { kind: 'card', key: `card:${card.id}:${actions.map((a) => a.id).join(',')}`, card, actions };
}

export type Pressed =
  | { readonly do: 'send'; readonly press: FamilyTvPress }
  | { readonly do: 'putAway'; readonly card: FamilyTvCard }
  /** Open the card's pages, at the first. */
  | { readonly do: 'read'; readonly reading: Reading }
  /** Open the seat beside her film. */
  | { readonly do: 'seat' }
  | { readonly do: 'clearSaid' }
  | { readonly do: 'nothing' };

/**
 * What OK on one of the card's buttons does. Only a button the server wrote
 * is ever sent to it — and never one of the three the television answers
 * itself.
 */
export function pressed(shown: Showing, actionId: string): Pressed {
  if (shown.kind === 'said') return { do: 'clearSaid' };
  if (shown.kind !== 'card') return { do: 'nothing' };
  if (shown.card.actions.length === 0) return { do: 'putAway', card: shown.card };
  if (!shown.card.actions.some((a) => a.id === actionId)) return { do: 'nothing' };
  if (actionId === FAMILY_TV_OWN_ACTIONS.later) return { do: 'putAway', card: shown.card };
  if (actionId === FAMILY_TV_OWN_ACTIONS.seat) return { do: 'seat' };
  if (actionId === FAMILY_TV_OWN_ACTIONS.read) {
    const reading = openReader(shown.card);
    return reading ? { do: 'read', reading } : { do: 'nothing' };
  }
  return { do: 'send', press: { cardId: shown.card.id, action: actionId } };
}

/**
 * The sentence that takes the card's place after a press. The server's, as
 * it stands — an answer that was not done is an ordinary answer. When
 * nothing came back the television cannot know whether the press arrived,
 * and says exactly that. Nothing when the whole screen is about to change
 * (not allowed, signed out): the looker shows that instead.
 */
export function sentenceAfterPress(answer: PressAnswer, residentName: string | undefined): string | undefined {
  if (answer.kind === 'said') return answer.say;
  if (answer.kind === 'failed') return `Wick could not reach ${residentName ? `${residentName}’s home` : 'the home'}, so that may not have been sent.`;
  return undefined;
}

/**
 * What the screen does once a press has been answered: the sentence to show
 * in the card's place, if any, and whether to open the seat.
 *
 * A quiet press shows nothing, whatever came back. When it was done, its
 * card is taken off this screen at once (`hide`) rather than a look later;
 * when it was not — "That week is not here to read." — or may not have
 * arrived, the card is whatever the home next says it is. Sitting down,
 * when it was done (the first time, or when already sat), opens the seat,
 * and the seat says its own sentence.
 */
export function afterPress(press: FamilyTvPress, answer: PressAnswer, residentName: string): { readonly say?: string; readonly seat: boolean; readonly hide: boolean } {
  const done = answer.kind === 'said' && answer.done;
  if (isFamilyTvQuietPress(press.action)) return { seat: false, hide: done };
  if (press.action === FAMILY_TV_PRESSES.sit && done) return { seat: true, hide: false };
  const say = sentenceAfterPress(answer, residentName);
  return { ...(say ? { say } : {}), seat: false, hide: false };
}

/**
 * The sentence to show in the seat after an answer at the credits, if any.
 * None when the answer was taken: the seat's own next sentence says what
 * each said, and goes on to say hers when it comes. The server's sentence
 * when it was not taken; and when it may not have arrived, that — so the
 * question is still there to answer again.
 */
export function afterSeatAnswer(answer: PressAnswer, residentName: string | undefined): string | undefined {
  if (answer.kind === 'said' && answer.done) return undefined;
  return sentenceAfterPress(answer, residentName);
}

export type Wave =
  /** A wave can be sent: one quiet button, the server's words on it. */
  | { readonly kind: 'button'; readonly label: string; readonly press: FamilyTvPress }
  /** The last one is still on her television: the server's sentence in the button's place, with nothing to press. */
  | { readonly kind: 'line'; readonly line: string };

/**
 * The wave on the home screen, for a member who may send one. It is pressed
 * on its own card and no other (familyClient.ts takes no other from the
 * server), so OK on it can never answer anything else.
 */
export function waveOf(home: FamilyTvHome | undefined): Wave | undefined {
  const wave = home?.wave;
  if (!wave) return undefined;
  if (wave.cardId) return { kind: 'button', label: wave.label, press: { cardId: wave.cardId, action: FAMILY_TV_PRESSES.wave } };
  return wave.line ? { kind: 'line', line: wave.line } : undefined;
}

/** Said over the seat, in the television's own words. */
export const SOMETHING_WAITS = 'Something is waiting for you. Press Back to see it.';

/**
 * Whether to say, over the seat, that something waits: whether the card
 * Back would show — the first not put away on this screen — waits for this
 * member's answer. That is a card with a button that is an answer, not one
 * of the television's own, and not the film's own card. Until the seat has
 * said which card is the film's, every film card is taken for it.
 *
 * Only that one card is looked at, so the sentence stays true: something
 * that ranks behind the film's own card — a wave that came back — says
 * nothing in the middle of the film. Nothing is drawn over the film for
 * it: one line, and Back.
 */
export function somethingWaits(home: FamilyTvHome | undefined, put: PutAway, seatCardId: string | undefined): boolean {
  const card = firstCard(home, put);
  if (!card) return false;
  if (seatCardId === undefined ? card.kind === 'watch' : card.id === seatCardId) return false;
  return card.actions.some((action) => !isFamilyTvOwnAction(action.id));
}

export interface ShownPicture {
  readonly cardId: string;
  readonly url: string;
}

/**
 * The picture beside the card. While the same card goes on carrying a
 * picture, the address already on screen is kept — the television looks
 * again every few seconds, and an address signed afresh each time would
 * load the picture again under the member's eyes. Kept in memory only, for
 * as long as the card shows it (INV-3): when the server stops sending one,
 * it goes.
 */
export function pictureToShow(showingNow: ShownPicture | undefined, card: FamilyTvCard | undefined): ShownPicture | undefined {
  if (!card?.pictureUrl) return undefined;
  if (showingNow && showingNow.cardId === card.id) return showingNow;
  return { cardId: card.id, url: card.pictureUrl };
}
