/**
 * The television's disk, stood in for — for tests only.
 *
 * `@amazon-devices/kepler-file-system` is a native module. A render test
 * hands it this instead:
 *
 *   vi.mock('@amazon-devices/kepler-file-system', () => import('../../__tests__/render/files.js'));
 *
 * It keeps files in memory, by path, with the three calls the app makes of
 * Vega's (headless/QueueStore.ts, seeing/seeingStore.ts). A test can read
 * what was written (`files`), put something there before the app reads it,
 * and empty it between tests (`resetFiles`).
 */

export const files = new Map<string, string>();

export const KeplerFileSystem = {
  exists: (path: string): Promise<boolean> => Promise.resolve(files.has(path)),
  readFileAsString: (path: string, _encoding: string): Promise<string> => {
    const content = files.get(path);
    return content === undefined ? Promise.reject(new Error(`no such file: ${path}`)) : Promise.resolve(content);
  },
  writeStringToFile: (path: string, content: string, _encoding: string): Promise<number> => {
    files.set(path, content);
    return Promise.resolve(content.length);
  },
};

export function resetFiles(): void {
  files.clear();
}
