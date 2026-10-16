/**
 * What waits, said while Wick is off the screen — the app's half.
 *
 * On Vega a background service goes on running behind another app
 * (headless/CardService.ts). For a family member's television it asks the
 * Wick server every so often whether anything waits for that member, and
 * puts up a system toast for each new thing (headless/waitingService.ts).
 *
 * The service needs a token, and the app cannot give it one: nothing passes
 * from an app to its service on the television (FRICTION.md FL-013, and the
 * findings of 2026-10-13 written up beside it). So the app opens a short
 * way for it at the pairing service, with its own token as proof
 * (pairing/PairingFlow.ts `openServiceWindow`), and then starts the
 * service, which takes it. In that order: a service started first would ask
 * before the way was open.
 *
 * On Fire OS a family member's television starts no service: its only
 * background service is the resident's door (apps/tv-fireos/src/door), and
 * apps/tv-fireos/src/overrides/launchCardService.ts gives this address as
 * empty, so nothing is opened and nothing is started.
 */
export async function startOffScreenService(deps: {
  /** The service's own address — empty where there is no service. */
  readonly serviceUri: string;
  readonly openWindow: () => Promise<void>;
  readonly launch: () => Promise<void>;
}): Promise<void> {
  if (!deps.serviceUri) return;
  try {
    await deps.openWindow();
  } catch (err) {
    // Where the disk keeps the television's token the service needs no way opened; start it all the same.
    console.error('off_screen_window_failed', err);
  }
  try {
    await deps.launch();
  } catch (err) {
    console.error('off_screen_service_failed', err);
  }
}
