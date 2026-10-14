/**
 * This television's identity: its id, and — where its storage can keep one
 * — a secret of its own.
 *
 * THE ID is a label, not a credential. INV-1's device-bound JWT is the
 * credential; the id is what the pairing API files it under, and what the
 * server looks the household up by (services/edge-device/lambda/
 * device-owner.mjs). It has to be the same on every launch — a new id is a
 * television the server has never seen, which means the pairing screen
 * again — and different on every television, because the server lets a
 * television belong to one household only. So it is generated once and kept
 * in the television's own storage. Where storage cannot keep anything, which
 * is every Vega Virtual Device (FRICTION.md FL-013), there is no way to be
 * both stable and unique, and stable wins: the simulator uses one fixed id.
 * Two simulators therefore cannot be paired to two households at once — the
 * second is told the television belongs to another home — which is the safe
 * failure.
 *
 * THE SECRET is what makes the id worth nothing on its own (AGENTS.md
 * INV-1). An id is not hidden: it was shown to family members, and it was
 * logged. So a television that can keep a file makes a long random secret
 * (random.ts), keeps it beside its id, and sends it to the pairing service
 * with every refresh. The service keeps only its hash, and from then on
 * mints a token for this id only to whoever shows the secret (edge-device
 * proof.mjs). The secret is sent when the television is paired
 * (`forPairing`), or — for a television paired before secrets — with its
 * first refresh that also shows a token it was paired with, which enrols it.
 * A television whose storage cannot keep the secret never makes one: the
 * Vega Virtual Device is answered from its id alone, the accepted exception.
 *
 * A NEW ID AT EVERY NEW PAIRING. A television that has been paired and is
 * paired again — disconnected, signed out, or its token refused — is a new
 * television to the server: a new id and a new secret, so an id somebody
 * once learnt stops being this one's. The old id and secret are sent along
 * (`replaces`), and when the code is entered the server removes the old row
 * if it keeps the same secret (edge-device pair-claim.mjs). The new identity
 * is only taken on once the code has been entered (`paired`): a code nobody
 * enters leaves the television exactly as it was. The simulator, which
 * keeps nothing, keeps its fixed id.
 *
 * Only the app writes this file (`televisionIdentity(fs, { writes: true })`).
 * The card service is another process, and reads it.
 *
 * There is no household here any more. A television learns whose it is from
 * the token it is handed when it is paired (INV-8).
 */
import type { FileSystemLike } from './headless/QueueStore.js';
import { DEVICE_ID_PATH, loadOrCreateDeviceId, randomDeviceId } from './headless/OnInstallTask.js';
import { TOKEN_PATH } from './pairing/PairingFlow.js';
import { randomHex } from './random.js';

/** The id of any television whose storage cannot keep one. */
export const SIMULATOR_DEVICE_ID = 'wick-tv';

/** Flat, directly under /data/ — see PairingFlow.ts's TOKEN_PATH comment for why. */
export const IDENTITY_PATH = '/data/wick-identity.json';

/** A television: its id, and its secret where it keeps one. */
export interface Identity {
  readonly deviceId: string;
  readonly proof?: string;
}

/** What a pairing is asked for with: the identity being paired, and the one it takes the place of. */
export interface PairingIdentity extends Identity {
  readonly replaces?: { readonly deviceId: string; readonly proof: string };
}

/** What is kept in IDENTITY_PATH. */
interface Kept {
  readonly deviceId: string;
  readonly proof: string;
  /** Whether a pairing has completed under this id: the next pairing is then a new television. */
  readonly paired: boolean;
  /** The identity a pairing under way is for, until its code is entered. */
  readonly next?: { readonly deviceId: string; readonly proof: string };
}

export interface TelevisionIdentity {
  /** This television's id now. */
  deviceId(): Promise<string>;
  /** The secret to send with a refresh for this id, or undefined where there is none. */
  proofFor(deviceId: string): Promise<string | undefined>;
  /** Who to ask for a code as: this television, or — once it has been paired — a new one in its place. */
  forPairing(deviceId: string): Promise<PairingIdentity>;
  /** The code was entered for this id: it is this television's identity from now on. */
  paired(deviceId: string): Promise<void>;
}

const ENCODING = 'utf8';
const SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const PROOF_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

/** A new secret: 32 random bytes as hex (edge-device proof.mjs takes 32 to 128 such characters). */
const newProof = (): string => randomHex(32);

function parse(raw: string | null | undefined): Kept | undefined {
  if (!raw) return undefined;
  try {
    const kept = JSON.parse(raw) as Partial<Kept> | null;
    if (!kept || typeof kept.deviceId !== 'string' || !SHAPE.test(kept.deviceId) || typeof kept.proof !== 'string' || !PROOF_SHAPE.test(kept.proof)) return undefined;
    const next = kept.next && typeof kept.next.deviceId === 'string' && SHAPE.test(kept.next.deviceId) && typeof kept.next.proof === 'string' && PROOF_SHAPE.test(kept.next.proof)
      ? { deviceId: kept.next.deviceId, proof: kept.next.proof }
      : undefined;
    return { deviceId: kept.deviceId, proof: kept.proof, paired: kept.paired === true, ...(next ? { next } : {}) };
  } catch {
    return undefined;
  }
}

async function readKept(fs: FileSystemLike): Promise<Kept | undefined> {
  try {
    if (!(await fs.exists(IDENTITY_PATH))) return undefined;
    return parse(await fs.readFileAsString(IDENTITY_PATH, ENCODING));
  } catch {
    return undefined;
  }
}

/** Written, and read back: only what is really on disk will be there next launch (FL-013). */
async function writeKept(fs: FileSystemLike, kept: Kept): Promise<boolean> {
  const text = JSON.stringify(kept);
  try {
    await fs.writeStringToFile(IDENTITY_PATH, text, ENCODING);
    return (await fs.readFileAsString(IDENTITY_PATH, ENCODING)) === text;
  } catch {
    return false;
  }
}

/** The id as it was kept before secrets: generated once (OnInstallTask.ts), or the simulator's. */
async function legacyDeviceId(fs: FileSystemLike, generateId?: () => string): Promise<string> {
  try {
    const id = await loadOrCreateDeviceId(fs, generateId);
    // loadOrCreateDeviceId survives a refused write by returning the id it
    // could not save. Only an id that is really on disk will still be there
    // next launch.
    if ((await fs.exists(DEVICE_ID_PATH)) && (await fs.readFileAsString(DEVICE_ID_PATH, ENCODING)) === id) return id;
  } catch {
    // Storage that throws is storage that cannot keep an id.
  }
  return SIMULATOR_DEVICE_ID;
}

/** Whether a token this television keeps names this id: it was paired under it before secrets were kept. */
async function tokenNames(fs: FileSystemLike, deviceId: string): Promise<boolean> {
  try {
    if (!(await fs.exists(TOKEN_PATH))) return false;
    return (JSON.parse(await fs.readFileAsString(TOKEN_PATH, ENCODING)) as { deviceId?: unknown } | null)?.deviceId === deviceId;
  } catch {
    return false;
  }
}

/** This television's id now: the kept identity's, or — before there is one — the id kept on its own. Read only. */
export async function resolveDeviceId(fs: FileSystemLike, generateId?: () => string): Promise<string> {
  return (await readKept(fs))?.deviceId ?? legacyDeviceId(fs, generateId);
}

export interface IdentityOptions {
  /** True for the app, the one process that makes and changes the identity. The card service only reads it. */
  readonly writes?: boolean;
  readonly generateId?: () => string;
  readonly generateProof?: () => string;
}

export function televisionIdentity(fs: FileSystemLike, options: IdentityOptions = {}): TelevisionIdentity {
  const writes = options.writes === true;
  const generateId = options.generateId ?? randomDeviceId;
  const generateProof = options.generateProof ?? newProof;
  /** The app's view: read, and made where it can be, once; then changed only here. */
  let mine: Promise<Kept | { readonly deviceId: string }> | undefined;

  /**
   * What this television is. A kept identity as it is. Otherwise the id kept
   * on its own (or the simulator's), and — for the app, where storage keeps
   * a file — a secret made for it now. Somebody holding a token that names
   * that id was paired under it: its next pairing is a new television.
   */
  const make = async (): Promise<Kept | { readonly deviceId: string }> => {
    const kept = await readKept(fs);
    if (kept) return kept;
    const deviceId = await legacyDeviceId(fs, options.generateId);
    if (!writes || deviceId === SIMULATOR_DEVICE_ID) return { deviceId };
    const made: Kept = { deviceId, proof: generateProof(), paired: await tokenNames(fs, deviceId) };
    return (await writeKept(fs, made)) ? made : { deviceId };
  };

  const current = (): Promise<Kept | { readonly deviceId: string }> => {
    if (!writes) return make();
    mine ??= make();
    return mine;
  };

  /** Changes the app's identity, if it can be written down; otherwise it stays as it was. */
  const change = async (next: Kept): Promise<boolean> => {
    if (!(await writeKept(fs, next))) return false;
    mine = Promise.resolve(next);
    return true;
  };

  const keeps = (who: Kept | { readonly deviceId: string }): who is Kept => 'proof' in who;

  return {
    async deviceId() {
      return (await current()).deviceId;
    },

    async proofFor(deviceId) {
      const who = await current();
      if (!keeps(who)) return undefined;
      if (who.deviceId === deviceId) return who.proof;
      return who.next?.deviceId === deviceId ? who.next.proof : undefined;
    },

    async forPairing() {
      const who = await current();
      if (!writes || !keeps(who)) return { deviceId: who.deviceId };
      if (!who.paired) return { deviceId: who.deviceId, proof: who.proof };
      // A new television in place of the one that was paired — the same new one for every code until one is entered.
      const next = who.next ?? { deviceId: generateId(), proof: generateProof() };
      if (!who.next && !(await change({ ...who, next }))) return { deviceId: who.deviceId, proof: who.proof };
      return { deviceId: next.deviceId, proof: next.proof, replaces: { deviceId: who.deviceId, proof: who.proof } };
    },

    async paired(deviceId) {
      const who = await current();
      if (!writes || !keeps(who)) return;
      if (who.next?.deviceId === deviceId) await change({ deviceId: who.next.deviceId, proof: who.next.proof, paired: true });
      else if (who.deviceId === deviceId && !who.paired) await change({ ...who, paired: true });
    },
  };
}
