/**
 * The door service's Headless JS task, as index.js registers it: the
 * Android service (DoorService.kt) starts it, and stops when it says it has
 * ended.
 *
 * Android starts the task once for each start of the service that finds
 * none running; one started while another holds the connection is given
 * the same hold, so a television never holds two background connections.
 */
import { loadDeviceConfig } from '../../../tv-vega/src/config.js';
import { KeplerFileSystem } from '../adapters/fileSystem';
import { doorRunner, holdDoor } from './doorService';
import { doorModule, nativeDoorAlerts } from './native';

/** The name DoorService.kt asks for. */
export const DOOR_TASK = 'WickDoorService';

const runner = doorRunner(() => holdDoor({ fs: KeplerFileSystem, config: loadDeviceConfig(), alerts: nativeDoorAlerts, fetchImpl: fetch }));

/** Settles when there is nothing left to hold, and tells Android so (door/native.ts `ended`). */
export async function doorTask(): Promise<void> {
  await runner.run();
  await doorModule?.ended();
}

/** Wick is on screen with this television's token (overrides/launchCardService.ts). */
export const reconsiderDoor = runner.reconsider;
