/**
 * com.wick.tv.rhythmSyncTask — nightly batch upload of local playback events
 * to Timestream. The Rhythm pillar's device-side input.
 *
 * Coalesce: 10s window on device, flush on state change. No reason to be chatty.
 */
export default async function doRhythmSync(): Promise<void> {
  throw new Error('not implemented');
}
