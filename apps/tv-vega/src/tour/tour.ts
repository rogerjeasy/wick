/**
 * How Wick works: a short tour, from a pill on the home screen
 * (docs/design/DESIGN.md §6).
 *
 * The television has to be able to show what it does to someone holding
 * only the remote — a judge with the Vega simulator, a son setting it up,
 * Margaret herself on the first evening — without anyone at the other end.
 * Each step is an example of one thing Wick does, drawn as that thing is
 * drawn and marked "Example". Nothing in it is sent, asked, read from the
 * server or kept: it is words and one bundled picture.
 *
 * OK is "Show me the next", Back closes the tour, and Play reads the step
 * aloud on a television that can read (the reading is the app's own: the
 * tour adds nothing to it).
 *
 * Pure, and imports nothing of the platform: the Vega app and the browser
 * television (apps/ops-console/tv.js) draw the same steps.
 */
import type { Say, WordKey } from '../words/words.js';

export type TourKind = 'door' | 'note' | 'hold' | 'read' | 'done';

export interface TourStep {
  readonly kind: TourKind;
  /** The step's headline. Those that name someone take `{name}`: the first person in her circle, or "your family". */
  readonly headlineKey: WordKey;
  /** What the example itself says: the door's sentence about its picture, the note's text. */
  readonly exampleKey?: WordKey | undefined;
  /** Why, in a sentence or two, under the example. */
  readonly detailKey: WordKey;
}

export const TOUR_STEPS: readonly TourStep[] = [
  { kind: 'door', headlineKey: 'tour.doorHeadline', exampleKey: 'tour.doorPicture', detailKey: 'tour.doorDetail' },
  { kind: 'note', headlineKey: 'tour.noteHeadline', exampleKey: 'tour.noteText', detailKey: 'tour.noteDetail' },
  { kind: 'hold', headlineKey: 'tour.holdHeadline', detailKey: 'tour.holdDetail' },
  { kind: 'read', headlineKey: 'tour.readHeadline', detailKey: 'tour.readDetail' },
  { kind: 'done', headlineKey: 'tour.doneHeadline', detailKey: 'tour.doneDetail' },
];

/** The two buttons of a step: "Show me the next" and "Close the tour", and on the last one "Back to the films" alone. */
export function tourActions(index: number): readonly { readonly id: 'next' | 'close'; readonly labelKey: WordKey; readonly kind: 'primary' | 'secondary' }[] {
  if (index >= TOUR_STEPS.length - 1) return [{ id: 'close', labelKey: 'tour.done', kind: 'primary' }];
  return [
    { id: 'next', labelKey: 'tour.next', kind: 'primary' },
    { id: 'close', labelKey: 'tour.close', kind: 'secondary' },
  ];
}

/** Where the tour is: a step, or over. */
export type TourState = { readonly open: false } | { readonly open: true; readonly index: number };

export const TOUR_CLOSED: TourState = { open: false };

/** The tour after a press: "next" moves on and closes after the last step, "close" and Back close it. */
export function tourAfter(state: TourState, press: 'open' | 'next' | 'close' | 'back'): TourState {
  if (press === 'open') return { open: true, index: 0 };
  if (!state.open) return state;
  if (press === 'next' && state.index < TOUR_STEPS.length - 1) return { open: true, index: state.index + 1 };
  return TOUR_CLOSED;
}

/** What a step says, in her language, with `name` — the first person in her circle, or "your family" — put in. */
export function stepWords(say: Say, step: TourStep, name: string): { readonly headline: string; readonly example?: string | undefined; readonly detail: string } {
  // A step's keys are chosen at run time; each names `{name}` or nothing, so `name` is all any of them takes.
  const loose = say as unknown as (key: WordKey, values: { readonly name: string }) => string;
  return { headline: loose(step.headlineKey, { name }), example: step.exampleKey ? loose(step.exampleKey, { name }) : undefined, detail: loose(step.detailKey, { name }) };
}
