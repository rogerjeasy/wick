/**
 * Where she stopped a film, so that it goes on from there.
 *
 * A film she leaves (Back, the home screen, the door) used to start again
 * at 0:00 the next time she chose it. Now its place is kept, per film, and
 * the film goes on from it. Not the first minute: starting again from there
 * is no loss. And not once she has reached the credits, or the last two
 * minutes of a film that has none: that film was watched, and starts from
 * the beginning.
 *
 * Kept where the television can keep it (`store`): the browser television's
 * own storage; on Vega and Fire OS, for as long as the app runs. A store that
 * refuses is a television that keeps nothing, and the film then goes on from
 * where it was within this session only.
 */

/** Before this, a film starts from the beginning. */
export const RESUME_AFTER_MS = 60_000;
/** A film with no credits marker counts as watched in its last two minutes. */
export const WATCHED_BEFORE_END_MS = 2 * 60_000;

/** The place worth keeping, or undefined when the film should start from the beginning. */
export function keptPosition(positionMs: number, durationMs: number, creditsPositionMs: number | undefined): number | undefined {
  if (!Number.isFinite(positionMs) || positionMs < RESUME_AFTER_MS) return undefined;
  if (creditsPositionMs !== undefined && positionMs >= creditsPositionMs) return undefined;
  if (creditsPositionMs === undefined && durationMs > 0 && positionMs >= durationMs - WATCHED_BEFORE_END_MS) return undefined;
  return Math.round(positionMs);
}

/** Where the places are kept: text in, text out. Either may throw; then nothing is kept beyond this session. */
export interface PositionStore {
  read(): string | null | undefined;
  write(text: string): void;
}

export class FilmPositions {
  readonly #store: PositionStore | undefined;
  readonly #places = new Map<string, number>();

  constructor(store?: PositionStore) {
    this.#store = store;
    try {
      const raw = store?.read();
      const kept = raw ? (JSON.parse(raw) as unknown) : undefined;
      if (kept && typeof kept === 'object') {
        for (const [id, ms] of Object.entries(kept as Record<string, unknown>)) {
          if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) this.#places.set(id, ms);
        }
      }
    } catch {
      // Nothing kept, or nothing readable: every film starts from the beginning.
    }
  }

  /** Where this film goes on from: its kept place, or 0. */
  startAt(programmeId: string): number {
    return this.#places.get(programmeId) ?? 0;
  }

  /** The film was left at `positionMs`: kept, or forgotten if it was watched or barely begun. */
  stopped(programmeId: string, positionMs: number, durationMs: number, creditsPositionMs: number | undefined): void {
    const kept = keptPosition(positionMs, durationMs, creditsPositionMs);
    if (kept === undefined) this.#places.delete(programmeId);
    else this.#places.set(programmeId, kept);
    try {
      this.#store?.write(JSON.stringify(Object.fromEntries(this.#places)));
    } catch {
      // A television that keeps nothing: the place lasts as long as the app does.
    }
  }
}
