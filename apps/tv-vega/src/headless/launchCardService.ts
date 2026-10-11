/**
 * Starting the card service. Nothing on Vega starts a `[[components.service]]`
 * by itself — not installing the app, not launching it, not offering the
 * service in the manifest (FL-014). What does is a message to the
 * component's own `pkg://` URI, which an app may send to itself; once
 * started, the service keeps running after the app leaves the screen
 * (FL-022, seen on the VVD).
 *
 * Asked for every time Wick comes on screen: the platform may stop a
 * service it needs the memory of, and asking again for one that is running
 * changes nothing.
 */
export const CARD_SERVICE_URI = 'pkg://com.wick.tv.card.service';

/** Never throws: without the service Wick still works whenever it is on screen. */
export async function launchCardService(openURL: (uri: string) => Promise<unknown>): Promise<void> {
  try {
    await openURL(CARD_SERVICE_URI);
  } catch (err) {
    console.error('card_service_launch_failed', err);
  }
}
