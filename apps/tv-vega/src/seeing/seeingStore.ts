/**
 * Where her Easier to see choice is kept (seeing.ts): one small file in the
 * same store as the cards and her language (headless/QueueStore.ts), on the
 * television and nowhere else. Neither call ever rejects: a disk that
 * cannot be read remembers nothing, and one that cannot be written forgets
 * at the next launch — which is what the Vega Virtual Device always does
 * (FRICTION.md FL-013).
 */
import { NO_CHOICE, readSeeing, writeSeeing, type SeeingChoice } from './seeing.js';

/** The part of Vega's file system this uses — the same as QueueStore's. */
export interface SeeingFileSystem {
  readFileAsString(path: string, encoding: string): Promise<string>;
  writeStringToFile(path: string, content: string, encoding: string): Promise<number>;
  exists(path: string): Promise<boolean>;
}

export const SEEING_PATH = '/data/wick-seeing.json';
const ENCODING = 'utf8';

export async function recallSeeing(fs: SeeingFileSystem, path: string = SEEING_PATH): Promise<SeeingChoice> {
  try {
    if (!(await fs.exists(path))) return NO_CHOICE;
    return readSeeing(await fs.readFileAsString(path, ENCODING));
  } catch {
    return NO_CHOICE;
  }
}

export async function keepSeeing(fs: SeeingFileSystem, choice: SeeingChoice, path: string = SEEING_PATH): Promise<void> {
  try {
    await fs.writeStringToFile(path, writeSeeing(choice), ENCODING);
  } catch {
    // Kept for this launch only.
  }
}
