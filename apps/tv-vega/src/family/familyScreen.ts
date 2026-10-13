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
 * Nothing leaves the screen on a countdown. A card goes when the server
 * stops sending it or the member puts it away; a sentence goes when the
 * member presses "All right".
 */
import type { CardAction, FamilyTvCard, FamilyTvHome, FamilyTvPress } from '@wick/contracts';
import type { PressAnswer } from './familyClient.js';

/** The television's own button. Its id is never sent to the server. */
export const ALL_RIGHT: CardAction = { id: 'wick-tv-all-right', label: 'All right', kind: 'primary' };

const NOTHING_WAITING = 'Nothing is waiting for you.';
/** A demo home says it is one wherever it is named (AGENTS.md, Data rules). */
const SIMULATED = 'This is a demo home. Its history is simulated.';

export function unreachableLine(residentName: string | undefined): string {
  return residentName ? `Wick cannot reach ${residentName}’s home just now.` : 'Wick cannot reach the home just now.';
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

/** Cards put away on this screen: each one's id, and what it said when it was put away. */
export type PutAway = Readonly<Record<string, string>>;

/**
 * What a card says, for telling whether it has changed. Not the address of
 * its picture: that may be signed afresh on every look, and a card must not
 * come back for that.
 */
function saying(card: FamilyTvCard): string {
  return JSON.stringify([card.headline, card.detail ?? null, card.actions.map((a) => [a.id, a.label])]);
}

export function putAway(put: PutAway, card: FamilyTvCard): PutAway {
  return { ...put, [card.id]: saying(card) };
}

/** What is still put away now that the server has answered again: not a card that changed, nor one that left. */
export function stillPutAway(put: PutAway, home: FamilyTvHome): PutAway {
  const kept: Record<string, string> = {};
  for (const card of home.cards) {
    if (put[card.id] !== undefined && put[card.id] === saying(card)) kept[card.id] = put[card.id]!;
  }
  return Object.keys(kept).length === Object.keys(put).length ? put : kept;
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
  const card = home?.cards.find((c) => put[c.id] === undefined || put[c.id] !== saying(c));
  if (!card) return { kind: 'nothing' };
  const actions = card.actions.length > 0 ? card.actions : [ALL_RIGHT];
  return { kind: 'card', key: `card:${card.id}:${actions.map((a) => a.id).join(',')}`, card, actions };
}

export type Pressed =
  | { readonly do: 'send'; readonly press: FamilyTvPress }
  | { readonly do: 'putAway'; readonly card: FamilyTvCard }
  | { readonly do: 'clearSaid' }
  | { readonly do: 'nothing' };

/** What OK on one of the card's buttons does. Only a button the server wrote is ever sent to it. */
export function pressed(shown: Showing, actionId: string): Pressed {
  if (shown.kind === 'said') return { do: 'clearSaid' };
  if (shown.kind !== 'card') return { do: 'nothing' };
  if (shown.card.actions.length === 0) return { do: 'putAway', card: shown.card };
  if (!shown.card.actions.some((a) => a.id === actionId)) return { do: 'nothing' };
  return { do: 'send', press: { cardId: shown.card.id, action: actionId } };
}

/**
 * The sentence that takes the card's place after a press. The server's, as
 * it stands — an answer that was not done is an ordinary answer. When
 * nothing came back the television cannot know whether the press arrived,
 * and says exactly that. Nothing when the whole screen is about to change
 * (not allowed, signed out): the looker shows that instead.
 */
export function sentenceAfterPress(answer: PressAnswer, residentName: string): string | undefined {
  if (answer.kind === 'said') return answer.say;
  if (answer.kind === 'failed') return `Wick could not reach ${residentName}’s home, so that may not have been sent.`;
  return undefined;
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
