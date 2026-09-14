/**
 * com.wick.tv.content.dataRefresh.provider — serves REAL Watch Activity to the
 * platform's Content Personalization service.
 *
 * Deliberately no mock handlers. The Vega sample wires
 * ContentPersonalizationMocks into exactly this file; `npm run check:no-mocks`
 * fails the build if that ever creeps back in. See §3.3, §12.1.
 */
// TODO(S6): register ContentPersonalizationServer with the real handlers.
export async function onStartDataRefresh(): Promise<void> {
  throw new Error('not implemented');
}
export async function onStopDataRefresh(): Promise<void> {
  throw new Error('not implemented');
}
