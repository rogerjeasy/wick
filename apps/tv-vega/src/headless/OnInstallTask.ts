/**
 * com.wick.tv.onInstallTask — first-run pairing state. Runs once, on install
 * (manifest.toml `[[tasks.work]] mode = "install"`).
 *
 * The only state that must exist before pairing can ever begin is a stable
 * per-device id (PairingFlow.start(deviceId) needs one). Generating and
 * persisting it here, idempotently, is exactly the "first-run" work this
 * task exists for; ../deviceId.ts reads it back on every launch.
 */
import type { FileSystemLike } from './QueueStore.js';
import { randomHex } from '../random.js';

// Flat, directly under /data/ — see PairingFlow.ts's TOKEN_PATH comment for
// why (/wick/... failed on-device with a bare com.amazon.kepler.io.IoError).
export const DEVICE_ID_PATH = '/data/wick-deviceId.json';
const ENCODING = 'utf8';

interface TestDeps {
  readonly fs: FileSystemLike;
  readonly generateId: () => string;
}

let testDeps: TestDeps | null = null;

/** Test-only seam — same shape as CardService.ts's, for the same reason. */
export function __setOnInstallTestDeps(deps: TestDeps | null): void {
  testDeps = deps;
}

/**
 * Not a secret — INV-1's device-bound JWT is the credential, and the
 * television's own secret (deviceId.ts) is what a refresh is proved by; this
 * id is only a stable label PairingFlow sends alongside the pairing request.
 * Still random through and through, with no time in it, so it cannot be
 * guessed from when Wick was installed. random.ts imports nothing native,
 * which keeps this task free of the import-time TurboModule lookup
 * CardService.ts's header warns about.
 */
export function randomDeviceId(): string {
  return `wick-${randomHex(16)}`;
}

/** Idempotent — safe to call more than once (reinstall, a retried task). */
export async function loadOrCreateDeviceId(fs: FileSystemLike, generateId: () => string = randomDeviceId): Promise<string> {
  if (await fs.exists(DEVICE_ID_PATH)) {
    const existing = await fs.readFileAsString(DEVICE_ID_PATH, ENCODING);
    if (existing) return existing;
  }
  const id = generateId();
  // Best-effort, same as PairingFlow.pollUntilBound (FRICTION.md FL-013): a
  // fresh id this task already generated must not be lost to the caller
  // just because /data can't hold onto it. Losing the write means the next
  // launch re-derives a new id instead of reusing this one — recoverable —
  // rather than this task rejecting outright, which install-time tasks have
  // no operator-visible way to surface.
  try {
    await fs.writeStringToFile(DEVICE_ID_PATH, id, ENCODING);
  } catch (err) {
    console.error('device_id_persist_failed', err);
  }
  return id;
}

export default async function doOnInstall(): Promise<void> {
  // Lazy-imported on the real (non-test) path only — see CardService.ts's
  // identical comment.
  const fs = testDeps?.fs ?? (await import('@amazon-devices/kepler-file-system')).KeplerFileSystem;
  const generateId = testDeps?.generateId ?? randomDeviceId;
  await loadOrCreateDeviceId(fs, generateId);
}
