/**
 * The three file calls Wick's television code makes
 * (apps/tv-vega/src/headless/QueueStore.ts `FileSystemLike`), kept in
 * Android's key-value storage with the file's path as the key.
 *
 * On Vega these are `KeplerFileSystem`'s. What they hold is small — the
 * device token, the television's id, the card queue — and is only ever read
 * and written whole, so a key per path is all a file needs to be here.
 *
 * Pure: the storage is passed in, so this is tested without a television.
 */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface StorageFileSystem {
  readFileAsString(path: string, encoding: string): Promise<string>;
  writeStringToFile(path: string, content: string, encoding: string): Promise<number>;
  exists(path: string): Promise<boolean>;
}

/** Keys are namespaced so nothing else kept in the same storage can be mistaken for a file. */
const key = (path: string): string => `wick:file:${path}`;

export function storageFileSystem(storage: KeyValueStorage): StorageFileSystem {
  return {
    async readFileAsString(path) {
      const content = await storage.getItem(key(path));
      // A missing file is an error on Vega too; callers ask `exists` first.
      if (content === null) throw new Error(`no such file: ${path}`);
      return content;
    },
    async writeStringToFile(path, content) {
      await storage.setItem(key(path), content);
      return content.length;
    },
    async exists(path) {
      return (await storage.getItem(key(path))) !== null;
    },
  };
}
