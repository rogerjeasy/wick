/**
 * What a press does to the screen. Pure and RN-import-free, like
 * messageActions.ts. The device still never decides *what* happens — the
 * agent plane does — only whether the thing the resident pressed is finished
 * from the screen's point of view.
 *
 * On a DOOR card only "Not now" is. The chime's answer ("The hallway chime
 * rang.") arrives as a patch onto this same card a second later (M1), and the
 * live view opens over the card so Back returns to it (M2, spec §4.3).
 *
 * "What Sarah sees" opens over the Week card, so Done returns to it; and the
 * sharing card's own toggle and Next are answered by the server replacing it
 * in place. Only Done finishes it.
 *
 * A Circle card is finished by either answer: the resident is asked once
 * (the default below), and the server records what they said. The same goes
 * for each of a watch-together session's cards.
 *
 * On the card her hold brings (packages/contracts/src/reach.ts), "Yes, ask
 * Sarah" and "Just say hello" leave it where it is: who was asked is
 * written onto that same card a moment later. Its other buttons finish it.
 *
 * The question about her language (packages/contracts/src/language.ts) is
 * finished by either answer, like the Circle card. What her yes changes
 * arrives afterwards, on the home message.
 *
 * A picture from the family (packages/contracts/src/mantel.ts) is put away
 * by either answer too: "Keep it" and "Thank you" look the same from the
 * screen, as they do from outside. If she pressed "Keep it" and her
 * mantelpiece is full, the server sends the card again with a line that
 * says so, and it is shown again by the ordinary rules — nothing here
 * remembers that it was answered (ResidentApp tells the break engine the
 * showing is over, BreakController.answered).
 *
 * A note is finished by any of its replies. Back on it is not one: it puts
 * the note aside to the home screen's quiet line (home/waiting.ts putAway),
 * where it waits for her answer.
 */
import { DOOR_ACTIONS, NOTE_ACTIONS, REACH_ACTIONS, SHARING_ACTIONS, WATCH_ACTIONS, WEEK_ACTIONS, type Card } from '@wick/contracts';
import type { Together } from '../watch/togetherReporter.js';

export function removesCard(card: Card, actionId: string): boolean {
  switch (card.type) {
    case 'DOOR':
      return actionId === DOOR_ACTIONS.dismiss;
    case 'WEEK':
      return actionId !== WEEK_ACTIONS.sharing;
    case 'SHARING':
      return actionId === SHARING_ACTIONS.done;
    case 'REACH':
      return actionId !== REACH_ACTIONS.ring && actionId !== REACH_ACTIONS.hello;
    case 'LANGUAGE':
      return true;
    case 'PHOTO':
      return true;
    case 'MESSAGE':
      return actionId !== NOTE_ACTIONS.later;
    default:
      return true;
  }
}

export function opensLiveView(card: Card, actionId: string): boolean {
  return card.type === 'DOOR' && actionId === DOOR_ACTIONS.watchLive;
}

/**
 * "Start the film" on the card that says someone is ready to watch with
 * her (packages/contracts/src/watch.ts): which film to open, and — while
 * that person can still be following — the session her player is to speak
 * for. This press is the consent the rule there rests on, so it is this
 * button on this card and nothing else; a card that has outlived its
 * session still opens the film, for her alone.
 */
export function startsFilm(card: Card, actionId: string, now: number): { readonly programmeId: string; readonly together?: Together } | undefined {
  if (card.type !== 'WATCH' || actionId !== WATCH_ACTIONS.start || !card.programmeId) return undefined;
  const followed = card.followedUntil !== undefined && now < card.followedUntil;
  return {
    programmeId: card.programmeId,
    ...(followed ? { together: { sessionId: card.sessionId, programmeId: card.programmeId, withName: card.withName, until: card.followedUntil! } } : {}),
  };
}
