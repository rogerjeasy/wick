/**
 * com.wick.tv.content.dataRefresh.provider — answers the platform's Content
 * Personalization pulls (personalization/handlers.ts). What she watches is
 * reported live from the player instead (personalization/report.ts).
 *
 * Deliberately no mock handlers. The Vega sample wires
 * ContentPersonalizationMocks into exactly this file; `npm run check:no-mocks`
 * fails the build if that ever creeps back in. See §3.3, §12.1.
 */
import type { IComponentInstance } from '@amazon-devices/react-native-kepler';
import type { ContentPersonalizationServer } from '@amazon-devices/kepler-content-personalization';
import { noopContentEntitlementsHandler, noopCustomerListEntriesHandler, noopPlaybackEventsHandler } from '../personalization/handlers.js';

interface TestDeps {
  readonly server: typeof ContentPersonalizationServer;
}

let testDeps: TestDeps | null = null;

/** Test-only seam — same shape as CardService.ts's, for the same reason. */
export function __setDataRefreshTestDeps(deps: TestDeps | null): void {
  testDeps = deps;
}

export async function onStartDataRefresh(componentInstance: IComponentInstance): Promise<void> {
  // Lazy-imported on the real (non-test) path only — see CardService.ts's
  // identical comment: a static top-level import of the native module would
  // throw outside an actual Vega runtime, before a test's
  // __setDataRefreshTestDeps ever gets a chance to substitute a fake.
  const server = testDeps?.server ?? (await import('@amazon-devices/kepler-content-personalization')).ContentPersonalizationServer;
  server.setPlaybackEventsHandlerForComponent(noopPlaybackEventsHandler, componentInstance);
  server.setCustomerListEntriesHandlerForComponent(noopCustomerListEntriesHandler, componentInstance);
  server.setContentEntitlementsHandlerForComponent(noopContentEntitlementsHandler, componentInstance);
}

export async function onStopDataRefresh(): Promise<void> {}
