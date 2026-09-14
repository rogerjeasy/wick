/**
 * com.wick.tv.card.service — holds the device channel while the app package is
 * alive, so a card can arrive without the UI being mounted.
 *
 * Isolated in its own process group (manifest.toml) so a UI crash cannot drop
 * the channel.
 *
 * NOTE: this does NOT make Wick able to draw over another app's playback. That
 * is SP-1, the project's pivot question. See docs/WICK-TECHNICAL.md §14.
 */
// TODO(S1): connect channel, persist queue, hand off to UI on foreground.
export async function onStartCardService(): Promise<void> {
  throw new Error('not implemented');
}
export async function onStopCardService(): Promise<void> {
  throw new Error('not implemented');
}
