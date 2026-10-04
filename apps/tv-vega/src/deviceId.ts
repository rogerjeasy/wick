/**
 * This television's identity: a label, not a credential. INV-1's
 * device-bound JWT is the credential; this is what the pairing API files it
 * under, and what the server looks the household up by
 * (services/edge-device/lambda/device-owner.mjs).
 *
 * It has to be the same on every launch — a new id is a television the
 * server has never seen, which means the pairing screen again — and
 * different on every television, because the server lets a television
 * belong to one household only.
 *
 * So it is generated once and kept in the television's own storage. Where
 * storage cannot keep anything, which is every Vega Virtual Device
 * (FRICTION.md FL-013), there is no way to be both stable and unique, and
 * stable wins: the simulator uses one fixed id. Two simulators therefore
 * cannot be paired to two households at once — the second is told the
 * television belongs to another home — which is the safe failure.
 *
 * There is no household here any more. A television learns whose it is from
 * the token it is handed when it is paired (INV-8).
 */
import type { FileSystemLike } from './headless/QueueStore.js';
import { DEVICE_ID_PATH, loadOrCreateDeviceId } from './headless/OnInstallTask.js';

/** The id of any television whose storage cannot keep one. */
export const SIMULATOR_DEVICE_ID = 'wick-tv';

export async function resolveDeviceId(fs: FileSystemLike, generateId?: () => string): Promise<string> {
  try {
    const id = await loadOrCreateDeviceId(fs, generateId);
    // loadOrCreateDeviceId survives a refused write by returning the id it
    // could not save. Only an id that is really on disk will still be there
    // next launch.
    if ((await fs.exists(DEVICE_ID_PATH)) && (await fs.readFileAsString(DEVICE_ID_PATH, 'utf8')) === id) return id;
  } catch {
    // Storage that throws is storage that cannot keep an id.
  }
  return SIMULATOR_DEVICE_ID;
}
