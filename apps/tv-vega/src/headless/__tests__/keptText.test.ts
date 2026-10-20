/**
 * What the television keeps for itself (headless/keptText.ts): read once,
 * answered from memory, written through — and a disk that refuses costs
 * only the keeping between launches.
 */
import { describe, expect, it } from 'vitest';
import { FilmPositions } from '../../watch/resume.js';
import { WatchTally } from '../../home/order.js';
import type { FileSystemLike } from '../QueueStore.js';
import { POSITIONS_PATH, TALLY_PATH, recallKept } from '../keptText.js';

function disk(files: Record<string, string> = {}): FileSystemLike & { files: Record<string, string> } {
  return {
    files,
    exists: async (path) => path in files,
    readFileAsString: async (path) => files[path] ?? '',
    writeStringToFile: async (path, content) => {
      files[path] = content;
      return content.length;
    },
  };
}

const refusing: FileSystemLike = {
  exists: () => Promise.reject(new Error('com.amazon.kepler.io.IoError')),
  readFileAsString: () => Promise.reject(new Error('com.amazon.kepler.io.IoError')),
  writeStringToFile: () => Promise.reject(new Error('com.amazon.kepler.io.IoError')),
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('what the television keeps', () => {
  it('reads what the last launch kept', async () => {
    const fs = disk({ [POSITIONS_PATH]: JSON.stringify({ sintel: 300_000 }) });
    const positions = new FilmPositions(await recallKept(fs, POSITIONS_PATH));
    expect(positions.startAt('sintel')).toBe(300_000);
  });

  it('writes where a film was left, for the next launch', async () => {
    const fs = disk();
    const positions = new FilmPositions(await recallKept(fs, POSITIONS_PATH));
    positions.stopped('sintel', 400_000, 888_000, 700_000);
    await settle();
    expect(JSON.parse(fs.files[POSITIONS_PATH]!)).toEqual({ sintel: 400_000 });
    expect(new FilmPositions(await recallKept(fs, POSITIONS_PATH)).startAt('sintel')).toBe(400_000);
  });

  it('counts the films she starts, and keeps the count', async () => {
    const fs = disk();
    const tally = new WatchTally(await recallKept(fs, TALLY_PATH));
    tally.started('sintel', 20);
    await settle();
    expect(new WatchTally(await recallKept(fs, TALLY_PATH)).get()).toEqual({ sintel: { evening: 1 } });
  });

  it('on a disk that refuses, keeps it for as long as the app runs', async () => {
    const store = await recallKept(refusing, POSITIONS_PATH);
    const positions = new FilmPositions(store);
    positions.stopped('sintel', 400_000, 888_000, 700_000);
    await settle();
    expect(positions.startAt('sintel')).toBe(400_000);
    expect(JSON.parse(store.read() as string)).toEqual({ sintel: 400_000 });
  });
});
