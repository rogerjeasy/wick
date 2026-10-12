/**
 * The light in the window, on her own home screen
 * (packages/contracts/src/light.ts): the two words on the button that shows
 * how her light stands, and the line that says who looked in.
 *
 * The server says how things stand, and writes the sentence about who
 * looked in (edge-device light.mjs, and the family's tools when somebody
 * looks); this only decides what is still worth showing.
 *
 * Pure.
 */
import type { HomeState, QueuedCard } from '@wick/contracts';

/** The button's words — or nothing, when there is no light for anyone to see. */
export function lightLabel(home: HomeState): string | undefined {
  if (home.light === 'on') return 'Light on';
  if (home.light === 'out') return 'Light out';
  return undefined;
}

const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * "Sarah looked in this morning." — the server's sentence, as it stands: it
 * knows what time it is where the house is. Shown only while the look is
 * still today's by this television's clock.
 */
export function lookedInLine(home: HomeState, now: number): string | undefined {
  const look = home.lookedIn;
  if (!look || !sameDay(new Date(look.at), new Date(now))) return undefined;
  return look.line;
}

/**
 * Light cards to put away: any that is not the card she has just asked to
 * see. The Light card is the answer to her press on the home screen and
 * nothing else — never something waiting for a break. One found without
 * that press was left by a launch that was cut short.
 */
export function unaskedLightCards(cards: readonly QueuedCard[], openedId: string | null): string[] {
  return cards.filter((queued) => queued.card.type === 'LIGHT' && queued.id !== openedId).map((queued) => queued.id);
}

/** How long after her press a Light card still counts as its answer. Long enough for a slow connection; short enough that it never surprises her later. */
export const LIGHT_ANSWER_WAIT_MS = 15_000;

/** Whether a Light card arriving now is the answer to the press she made at `askedAt`. */
export function answersHerPress(askedAt: number | null, now: number): boolean {
  return askedAt !== null && now - askedAt < LIGHT_ANSWER_WAIT_MS;
}
