import { describe, expect, it, afterEach } from 'vitest';
import { __setDataRefreshTestDeps, onStartDataRefresh, onStopDataRefresh } from '../DataRefreshService.js';
import type { FileSystemLike } from '../QueueStore.js';

function fakeFs(): FileSystemLike {
  const files = new Map<string, string>();
  return {
    async exists(path) {
      return files.has(path) && files.get(path) !== '';
    },
    async readFileAsString(path) {
      return files.get(path) ?? '';
    },
    async writeStringToFile(path, content) {
      files.set(path, content);
      return content.length;
    },
  };
}

afterEach(async () => {
  await onStopDataRefresh();
  __setDataRefreshTestDeps(null);
});

describe('DataRefreshService', () => {
  it('registers all three handlers against the given component instance', async () => {
    const calls: string[] = [];
    const componentInstance = {} as never;
    __setDataRefreshTestDeps({
      fs: fakeFs(),
      server: {
        setPlaybackEventsHandlerForComponent: (_h: unknown, c: unknown) => {
          calls.push('playback');
          expect(c).toBe(componentInstance);
        },
        setCustomerListEntriesHandlerForComponent: (_h: unknown, c: unknown) => {
          calls.push('customerList');
          expect(c).toBe(componentInstance);
        },
        setContentEntitlementsHandlerForComponent: (_h: unknown, c: unknown) => {
          calls.push('entitlements');
          expect(c).toBe(componentInstance);
        },
      } as never,
    });

    await onStartDataRefresh(componentInstance);
    expect(calls.sort()).toEqual(['customerList', 'entitlements', 'playback']);
  });
});
