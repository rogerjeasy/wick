import { describe, expect, it, afterEach } from 'vitest';
import { __setDataRefreshTestDeps, onStartDataRefresh, onStopDataRefresh } from '../DataRefreshService.js';

afterEach(async () => {
  await onStopDataRefresh();
  __setDataRefreshTestDeps(null);
});

describe('DataRefreshService', () => {
  it('registers all three handlers against the given component instance', async () => {
    const calls: string[] = [];
    const componentInstance = {} as never;
    __setDataRefreshTestDeps({
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
