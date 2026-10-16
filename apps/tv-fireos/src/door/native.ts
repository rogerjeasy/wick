/**
 * The door, outside Wick, on Fire OS — the JavaScript side of the Android
 * module that starts the door service and puts its notifications up and
 * down (android/app/src/main/java/com/wick/tv/door/DoorAlertModule.kt).
 *
 * Nothing here decides anything: what a notification says, and whether
 * there is one, is door/doorAlert.ts; when, door/doorService.ts.
 */
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import type { DoorAlert } from './doorAlert';
import type { DoorAlerts } from './doorService';

interface WickDoorAlertModule {
  /** Starts the foreground service, which holds the door's connection behind another app. Running already, nothing changes. */
  start(listening: string): Promise<void>;
  show(alert: DoorAlert): Promise<void>;
  clear(cardId: string): Promise<void>;
  /** Every door notification Wick has up: Wick is in front, and the card itself is on the screen. */
  clearAll(): Promise<void>;
  /**
   * The door task has nothing left to hold, and the service stops. Said by the task itself: React Native 0.83's
   * new architecture registers no HeadlessJsTaskSupport, so Android is never told a Headless JS task has ended.
   */
  ended(): Promise<void>;
}

/** Absent only in a build without the module; the app then works as before, while it is on screen. */
export const doorModule: WickDoorAlertModule | undefined = (NativeModules as { WickDoorAlert?: WickDoorAlertModule }).WickDoorAlert;

export const nativeDoorAlerts: DoorAlerts = {
  show: async (alert) => {
    await doorModule?.show(alert);
  },
  clear: async (cardId) => {
    await doorModule?.clear(cardId);
  },
};

/** Android's version number, and whether it already lets Wick put up notifications. */
export async function notifyPermission(): Promise<{ readonly sdk: number; readonly granted: boolean }> {
  const sdk = Platform.OS === 'android' && typeof Platform.Version === 'number' ? Platform.Version : 0;
  // Android 13's permission: on anything older there is nothing to ask, and it is granted at install.
  const granted = sdk < 33 || (await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS));
  return { sdk, granted };
}

/** The system's own question, on the television. Her answer is Android's to keep. */
export async function askToNotify(): Promise<void> {
  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
}
