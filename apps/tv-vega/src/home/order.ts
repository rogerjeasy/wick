/**
 * The order of her films on the home screen (docs/design/DESIGN.md §6):
 * home adapts to her, and says how.
 *
 *   1. A film she stopped part-way, first, marked "Carry on" with how long
 *      is left (watch/resume.ts says what counts as part-way).
 *   2. Then the films she has watched most at this time of day — morning,
 *      afternoon or evening — counted on this television.
 *   3. Then the rest, in the catalogue's order.
 *
 * Counted, never guessed: no model, nothing sent anywhere, and the same
 * history always gives the same order. A tie keeps the catalogue's order,
 * so a television with no history shows the catalogue as it always did.
 *
 * Pure, and imports nothing of the platform. The tally is kept with the
 * same kind of store as the films' positions (resume.ts PositionStore):
 * the app's file on Vega and Fire OS, localStorage in the browser.
 */
import type { PartOfDay } from '@wick/contracts';
import type { PositionStore } from '../watch/resume.js';

export type { PartOfDay };

/** Morning until noon, afternoon until six, evening after — as her greeting counts them (home/herDay.ts). */
export function partOfDay(hour: number): PartOfDay {
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

/** How many times each film was started at each part of the day. */
export type Tally = Readonly<Record<string, Readonly<Partial<Record<PartOfDay, number>>>>>;

export interface Ordered<P> {
  readonly programme: P;
  /** Where she left it, when she stopped it part-way: the tile says "Carry on". */
  readonly resumeAtMs?: number | undefined;
}

/**
 * Her films in the order the home screen shows them. `startAt` is where a
 * film would start (resume.ts FilmPositions.startAt): above zero, she left
 * it part-way.
 */
export function orderProgrammes<P extends { readonly id: string }>(
  programmes: readonly P[],
  at: { readonly startAt: (programmeId: string) => number; readonly tally: Tally; readonly hour: number },
): Ordered<P>[] {
  const part = partOfDay(at.hour);
  const ranked = programmes.map((programme, index) => {
    const resumeAtMs = at.startAt(programme.id);
    const partWay = resumeAtMs > 0;
    const watched = at.tally[programme.id]?.[part] ?? 0;
    return { programme, index, partWay, resumeAtMs: partWay ? resumeAtMs : undefined, watched };
  });
  ranked.sort((a, b) => Number(b.partWay) - Number(a.partWay) || b.watched - a.watched || a.index - b.index);
  return ranked.map(({ programme, resumeAtMs }) => (resumeAtMs === undefined ? { programme } : { programme, resumeAtMs }));
}

/** The tally, with one more start of this film at this part of the day. */
export function counted(tally: Tally, programmeId: string, hour: number): Tally {
  const part = partOfDay(hour);
  const before = tally[programmeId] ?? {};
  return { ...tally, [programmeId]: { ...before, [part]: (before[part] ?? 0) + 1 } };
}

/** What the store holds, read with care: anything that is not a tally is no tally. */
export function readTally(text: string | null | undefined): Tally {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const tally: Record<string, Partial<Record<PartOfDay, number>>> = {};
    for (const [id, parts] of Object.entries(parsed as Record<string, unknown>)) {
      if (!parts || typeof parts !== 'object') continue;
      const kept: Partial<Record<PartOfDay, number>> = {};
      for (const part of ['morning', 'afternoon', 'evening'] as const) {
        const n = (parts as Record<string, unknown>)[part];
        if (typeof n === 'number' && Number.isInteger(n) && n > 0) kept[part] = n;
      }
      tally[id] = kept;
    }
    return tally;
  } catch {
    return {};
  }
}

/** The tally kept in a store: read once, counted on each film she starts. */
export class WatchTally {
  private tally: Tally;

  constructor(private readonly store: PositionStore) {
    let text: string | null | undefined;
    try {
      text = store.read();
    } catch {
      text = null;
    }
    this.tally = readTally(text);
  }

  get(): Tally {
    return this.tally;
  }

  started(programmeId: string, hour: number): void {
    this.tally = counted(this.tally, programmeId, hour);
    try {
      this.store.write(JSON.stringify(this.tally));
    } catch {
      // A television that cannot keep it orders by what it has: this session's films.
    }
  }
}
