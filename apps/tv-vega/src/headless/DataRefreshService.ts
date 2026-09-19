/**
 * com.wick.tv.content.dataRefresh.provider — serves REAL Watch Activity to the
 * platform's Content Personalization service.
 *
 * Deliberately no mock handlers. The Vega sample wires
 * ContentPersonalizationMocks into exactly this file; `npm run check:no-mocks`
 * fails the build if that ever creeps back in. See §3.3, §12.1.
 */
import type { IComponentInstance } from '@amazon-devices/react-native-kepler';
import type { ContentPersonalizationServer } from '@amazon-devices/kepler-content-personalization';
import { createPlaybackEventsHandler, noopContentEntitlementsHandler, noopCustomerListEntriesHandler } from '../personalization/handlers.js';
import { PlaybackEventStore } from '../personalization/PlaybackEventStore.js';
import type { FileSystemLike } from './QueueStore.js';

interface TestDeps {
  readonly fs: FileSystemLike;
  readonly server: typeof ContentPersonalizationServer;
}

let testDeps: TestDeps | null = null;

/** Test-only seam — same shape as CardService.ts's, for the same reason. */
export function __setDataRefreshTestDeps(deps: TestDeps | null): void {
  testDeps = deps;
}

let store: PlaybackEventStore | undefined;

export async function onStartDataRefresh(componentInstance: IComponentInstance): Promise<void> {
  // Lazy-imported on the real (non-test) path only — see CardService.ts's
  // identical comment: a static top-level import of either native module
  // would throw outside an actual Vega runtime, before a test's
  // __setDataRefreshTestDeps ever gets a chance to substitute a fake.
  const fs = testDeps?.fs ?? (await import('@amazon-devices/kepler-file-system')).KeplerFileSystem;
  const server = testDeps?.server ?? (await import('@amazon-devices/kepler-content-personalization')).ContentPersonalizationServer;

  store = new PlaybackEventStore(fs);
  server.setPlaybackEventsHandlerForComponent(createPlaybackEventsHandler(store), componentInstance);
  server.setCustomerListEntriesHandlerForComponent(noopCustomerListEntriesHandler, componentInstance);
  server.setContentEntitlementsHandlerForComponent(noopContentEntitlementsHandler, componentInstance);
}

export async function onStopDataRefresh(): Promise<void> {
  store = undefined;
}
