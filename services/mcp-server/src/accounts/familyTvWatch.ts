/**
 * Sarah's television, the film seat (packages/contracts familyTelevision.ts,
 * card kind `watch`, and `GET /tv/seat`): a film this member arranged with
 * the resident — when it is, sitting down to it, the seat beside it, and
 * the one question at the end.
 *
 * Everything here is made from `describeWatch` (tools/watchSession.ts), the
 * tools' own account of a session, so the rule in packages/contracts
 * watch.ts is kept where it already is: where her film has got to is in a
 * view only between her press on "Start the film" and the end of that
 * showing, and never past the invitation's window. Nothing here reads a
 * session's row for itself or works out a position.
 *
 * And a view is only ever made of the sessions `mySessions` hands over —
 * the ones this member invited her to. For anybody else in the circle there
 * is no card and an empty seat: the very answer given when there is no film.
 *
 * Pure: the caller does the one read.
 */
import { FAMILY_TV_OWN_ACTIONS, FAMILY_TV_PRESSES, WATCH_QUESTION, familyTvCardId, type CardAction, type FamilyTvCard, type FamilyTvSeat } from '@wick/contracts';
import { describeWatch, type WatchSession } from '../tools/watchSession.js';
import { action, type TvCaller } from './familyTvTypes.js';

const LATER: CardAction = { id: FAMILY_TV_OWN_ACTIONS.later, label: 'Not now', kind: 'dismiss' };
/** Sent to the server: sitting down, as join_watch_together does. */
const SIT_DOWN: readonly CardAction[] = [{ id: FAMILY_TV_PRESSES.sit, label: 'Sit down', kind: 'primary' }, LATER];
/** The television's own: opens the seat, and sends nothing. */
const TAKE_SEAT: readonly CardAction[] = [{ id: FAMILY_TV_OWN_ACTIONS.seat, label: 'Take your seat', kind: 'primary' }, LATER];

export interface WatchCardFound {
  readonly card: FamilyTvCard;
  /** It is time, and the member has not sat down: the one state of a film that waits for them. */
  readonly timeToSit: boolean;
  /** Nothing left to do: what each of them said about it, kept so it is not lost when the seat is left. */
  readonly settled: boolean;
}

function cardFor(resident: string, session: WatchSession, now: number): WatchCardFound | undefined {
  const view = describeWatch(session, now, resident);
  const id = familyTvCardId('watch', view.sessionId);
  const card = (headline: string, actions: readonly CardAction[], detail?: string): FamilyTvCard => ({ id, kind: 'watch', headline, ...(detail ? { detail } : {}), actions });

  switch (view.state) {
    case 'accepted': {
      const headline = `${view.film} with ${resident}, ${view.when}.`;
      return view.canSitDown
        ? { timeToSit: true, settled: false, card: card(headline, SIT_DOWN, `You can sit down now. ${resident}’s television will say you are ready.`) }
        : { timeToSit: false, settled: false, card: card(headline, [], 'You can sit down here from half an hour before.') };
    }
    case 'ready':
      return { timeToSit: false, settled: false, card: card(`Waiting for ${resident} to start ${view.film}.`, TAKE_SEAT) };
    case 'watching':
      return { timeToSit: false, settled: false, card: card(`${resident} has started ${view.film}.`, TAKE_SEAT) };
    case 'watched':
      // While the question can still be answered: `answers` is offered until the member has, and the window is open.
      if (view.answers) return { timeToSit: false, settled: false, card: card(`${view.film} has ended. There is one question for you.`, TAKE_SEAT) };
      // Answered: who said what — the tools' own sentence (watchSession.ts answersInWords) — for as long as the
      // invitation's window is open. Her answer is on this card only once the member has given theirs.
      if (view.yourAnswer && view.answersInWords && now < session.closesAt) {
        return { timeToSit: false, settled: true, card: card(`${view.film}. ${view.answersInWords}`, []) };
      }
      return undefined;
    // Not answered yet, declined, taken back, called off, passed over, left, or the time gone: nothing to show.
    default:
      return undefined;
  }
}

/**
 * The one film card of a home screen: of this member's sessions (newest
 * first), the one that wants something of them before one that only says
 * when.
 */
export function watchCard(who: TvCaller, sessions: readonly WatchSession[], now: number): WatchCardFound | undefined {
  const found = sessions.map((session) => cardFor(who.household.residentName, session, now)).filter((card): card is WatchCardFound => card !== undefined);
  return found.find((entry) => entry.card.actions.length > 0) ?? found[0];
}

function seatFor(resident: string, session: WatchSession, now: number): FamilyTvSeat | undefined {
  // The seat is for somebody who has sat down, and for no longer than the invitation's own window.
  if (session.joinedAt === undefined || now >= session.closesAt) return undefined;
  const view = describeWatch(session, now, resident);
  const base = { cardId: familyTvCardId('watch', view.sessionId), film: view.film };
  // Exactly as the view has them: there only while the rule in watch.ts allows.
  const following = { ...(view.stream ? { stream: view.stream } : {}), ...(view.playback ? { playback: view.playback } : {}) };
  const said = { ...(view.yourAnswer ? { yourAnswer: view.yourAnswer } : {}), ...(view.theirAnswer ? { theirAnswer: view.theirAnswer } : {}) };

  switch (view.state) {
    case 'ready':
      return { ...base, state: 'waiting', line: `Waiting for ${resident} to start the film.`, ...following };
    case 'watching':
      return { ...base, state: 'watching', line: `You are watching ${view.film} with ${resident}.`, ...following };
    case 'watched':
      // The question is open until the member answers. Her answer, if she was first, is carried as the tool carries it
      // (`theirAnswer`) and is not in the line: the line is the question.
      if (view.answers) {
        return { ...base, state: 'asked', line: WATCH_QUESTION, ...following, question: WATCH_QUESTION, answers: view.answers.map(({ key, text }, index) => action(key, text, index)), ...said };
      }
      return {
        ...base,
        state: 'over',
        // The seat goes on being asked while it is over, so her answer arrives in this line when she gives it.
        // Who said what is the tools' own sentence, so the television and get_watch_together cannot disagree.
        line: view.yourAnswer && view.answersInWords ? view.answersInWords : `${view.film} has ended.`,
        ...following,
        question: WATCH_QUESTION,
        ...said,
      };
    case 'stopped':
      return { ...base, state: 'over', line: `${resident} has left the film.` };
    case 'passed':
      return { ...base, state: 'over', line: `${resident} chose not to watch just now.` };
    default:
      return undefined;
  }
}

/** The seat beside her film, for the newest of this member's sessions that has one. */
export function watchSeat(who: TvCaller, sessions: readonly WatchSession[], now: number): FamilyTvSeat | undefined {
  for (const session of sessions) {
    const seat = seatFor(who.household.residentName, session, now);
    if (seat) return seat;
  }
  return undefined;
}
