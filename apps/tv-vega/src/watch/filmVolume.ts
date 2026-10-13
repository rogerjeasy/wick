/**
 * The film under a card that is being read aloud (packages/contracts/src/
 * speech.ts). Only the door's card is ever shown over a film that is
 * playing — every other card holds the film first — so this is the one
 * case where a voice and a soundtrack would be heard at once. The film is
 * turned down to about a third for the reading, and put back exactly as it
 * was when the reading is over, however it ends.
 *
 * Pure: the player is anything with a `volume` (0..1), as both televisions'
 * players have.
 */
export interface HasVolume {
  volume: number;
}

/** How loud the film is while a card is read over it. */
export const FILM_VOLUME_WHILE_READING = 0.3;

/**
 * Turns the film down, and gives back the way to put it as it was. Never
 * turns it up: a film already quieter is left alone. The way back does its
 * work once, only while that film is still the one on screen
 * (`stillOnScreen`), and never throws — a player that has been let go will
 * not take a volume, and there is then nothing to put back.
 */
export function lowerFilm(film: HasVolume | null | undefined, stillOnScreen: () => boolean = () => true): () => void {
  if (!film) return () => undefined;
  let before: number | undefined;
  try {
    before = film.volume;
    if (before > FILM_VOLUME_WHILE_READING) film.volume = FILM_VOLUME_WHILE_READING;
  } catch {
    before = undefined;
  }
  return () => {
    const was = before;
    before = undefined;
    if (was === undefined || !stillOnScreen()) return;
    try {
      film.volume = was;
    } catch {
      // Let go already: nothing is playing to be put back.
    }
  };
}
