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
 */
import { DOOR_ACTIONS, SHARING_ACTIONS, WEEK_ACTIONS, type Card } from '@wick/contracts';

export function removesCard(card: Card, actionId: string): boolean {
  switch (card.type) {
    case 'DOOR':
      return actionId === DOOR_ACTIONS.dismiss;
    case 'WEEK':
      return actionId !== WEEK_ACTIONS.sharing;
    case 'SHARING':
      return actionId === SHARING_ACTIONS.done;
    default:
      return true;
  }
}

export function opensLiveView(card: Card, actionId: string): boolean {
  return card.type === 'DOOR' && actionId === DOOR_ACTIONS.watchLive;
}
