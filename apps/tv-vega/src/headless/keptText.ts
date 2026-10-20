/**
 * A little text the television keeps for itself, in the same file system
 * as its queue (QueueStore.ts): where she left each film
 * (watch/resume.ts FilmPositions) and how often she starts each one at
 * each part of the day (home/order.ts WatchTally). Neither leaves the
 * television, and neither is ever sent anywhere.
 *
 * The two want their text at once, and a disk answers later: so it is read
 * once (`recallKept`), held in memory, and written through as it changes.
 * A disk that refuses — the Vega simulator's always does (FRICTION.md
 * FL-013) — costs only the keeping between launches: within one, the text
 * is in memory. On Fire OS the file system is the app's own storage
 * (apps/tv-fireos adapters/fileSystem.ts), which keeps it.
 */
import type { PositionStore } from '../watch/resume.js';
import type { FileSystemLike } from './QueueStore.js';

/** Where the films' places are kept, beside the queue (QueueStore.ts says why flat, under /data/). */
export const POSITIONS_PATH = '/data/wick-positions.json';
/** Where the count of the films she starts is kept. */
export const TALLY_PATH = '/data/wick-tally.json';

const ENCODING = 'utf8';

/** The text at `path`, read once, and a store that answers from memory and writes through to the file. */
export async function recallKept(fs: FileSystemLike, path: string): Promise<PositionStore> {
  let text: string | null = null;
  try {
    if (await fs.exists(path)) text = await fs.readFileAsString(path, ENCODING);
  } catch {
    // Nothing kept, or a disk that keeps nothing: memory only.
  }
  let writes: Promise<unknown> = Promise.resolve();
  return {
    read: () => text,
    write: (next) => {
      text = next;
      // One at a time, in order, so a later place is never overwritten by an earlier one.
      writes = writes.then(() => fs.writeStringToFile(path, next, ENCODING)).catch(() => undefined);
    },
  };
}
