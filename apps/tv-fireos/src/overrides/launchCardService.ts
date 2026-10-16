/**
 * Replaces apps/tv-vega/src/headless/launchCardService.ts on Fire OS.
 *
 * On Vega this starts the background card service by opening the app's own
 * `pkg://` address. Android has no such address. Here it starts the door
 * service — an Android foreground service running door/doorService.ts —
 * through Wick's own module (door/native.ts), which the app may do while it
 * is on screen, as it is whenever this is called (ResidentApp.tsx: once
 * paired, and each time Wick comes back on screen). One that is running
 * already is left as it is.
 *
 * Three more things happen here, because here is where Wick has just come in
 * front of her:
 *
 *   - Any door notification Wick has up is taken down. The card it pointed
 *     at is now on the screen, which is all the notification was for.
 *   - A door service still holding the connection of the television this
 *     was before it was paired again is made to take it up anew, with the
 *     token the app keeps now (door/doorService.ts `doorRunner`).
 *   - On Android 13 and later she is asked, once, whether Wick may put up
 *     notifications (door/doorAlert.ts `shouldAskToNotify`). Fire OS 7 and 8
 *     never ask.
 *
 * `CARD_SERVICE_URI` stays empty: it is the address a family member's own
 * television would open its Vega service by (family/offScreen.ts), and on
 * Fire OS a family television starts nothing. Only the resident's
 * television calls launchCardService.
 *
 * Same exports as the file it replaces; src/__tests__/parity.test.ts holds
 * that to be so.
 */
import { words } from '../../../tv-vega/src/words/words.js';
import { KeplerFileSystem } from '../adapters/fileSystem';
import { shouldAskToNotify } from '../door/doorAlert';
import { TOKEN_PATH } from '../../../tv-vega/src/pairing/PairingFlow.js';
import { rememberedLanguage, type Whose } from '../door/doorService';
import { askToNotify, doorModule, notifyPermission } from '../door/native';
import { reconsiderDoor } from '../door/task';

export const CARD_SERVICE_URI = '';

/** Written once she has been asked, so she is never asked again. Her answer is Android's to keep, not this file's. */
const ASKED_PATH = '/data/wick-notifications-asked.json';

/** Whose television the app holds now: the token it keeps. */
async function whoseNow(): Promise<Whose | undefined> {
  try {
    const kept = JSON.parse(await KeplerFileSystem.readFileAsString(TOKEN_PATH, 'utf8')) as Partial<Whose> | null;
    return typeof kept?.deviceId === 'string' && typeof kept.householdId === 'string' ? { deviceId: kept.deviceId, householdId: kept.householdId } : undefined;
  } catch {
    return undefined;
  }
}

/** Never throws, like the original: without the service Wick still works whenever it is on screen. */
export async function launchCardService(_openURL: (uri: string) => Promise<unknown>): Promise<void> {
  const door = doorModule;
  if (!door) return;
  try {
    await door.clearAll();
    // Paired again since the service took up its connection: it is taken up again, for this television.
    const whose = await whoseNow();
    if (whose) reconsiderDoor(whose);
    const permission = await notifyPermission();
    const askedBefore = await KeplerFileSystem.exists(ASKED_PATH);
    if (shouldAskToNotify({ ...permission, askedBefore })) {
      // Written first: the system's question takes Wick off the screen for a moment, and back on it calls this again.
      await KeplerFileSystem.writeStringToFile(ASKED_PATH, JSON.stringify(true), 'utf8');
      await askToNotify();
    }
    await door.start(words(await rememberedLanguage(KeplerFileSystem))('doorAlert.listening'));
  } catch (err) {
    console.error('door_service_launch_failed', err);
  }
}
