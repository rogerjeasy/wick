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
 * Two simulators therefore cannot be paired to two households at once. A
 * real home's simulator is never taken from it — the second is told the
 * television belongs to another home, the safe failure — but one held by a
 * demo home is taken by the next pairing (edge-device pair-claim.mjs
 * takeSimulatorFromDemoHome), so a judge's simulator is never refused
 * because another was paired to another demo home first.
 *
 * THE SECRET is what makes the id worth nothing on its own (AGENTS.md
 * INV-1). An id is not hidden: it was shown to family members, and it was
 * logged. So a television whose storage keeps a file keeps a long random
 * secret beside its id, and sends it to the pairing service with every
 * refresh. The service keeps only its hash, and from then on mints a token
 * for this id only to whoever shows the secret (edge-device proof.mjs).
 * Where the secret comes from:
 *
 *   - made here, from the platform's cryptographic generator (random.ts) —
 *     Fire OS — and sent when the television asks for a code;
 *   - or, where there is no such generator (Vega), made by the pairing
 *     service when the code is entered and handed over once with the token
 *     (`keeps`, `paired`). The television asked for it only after writing
 *     its identity and reading it back, so it will still have it next launch.
 *
 * Never from Math.random. A television paired before secrets that can make
 * one enrols it with its first refresh that also shows a token it was paired
 * with; one that cannot gets one at its next pairing. A television whose
 * storage keeps nothing — the Vega Virtual Device — never asks for one and is
 * never given one: a secret it could not keep would lock it out at its next
 * launch. It is answered from its id alone, the accepted exception.
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
import { secureHex } from './random.js';
import { SIMULATOR_DEVICE_ID } from '@wick/contracts';

/** The id of any television whose storage cannot keep one (contracts device.ts). */
export { SIMULATOR_DEVICE_ID };

/** Flat, directly under /data/ — see PairingFlow.ts's TOKEN_PATH comment for why. */
export const IDENTITY_PATH = '/data/wick-identity.json';

/** A television: its id, and its secret where it keeps one. */
export interface Identity {
  readonly deviceId: string;
  readonly proof?: string;
}

/**
 * What a pairing is asked for with: the identity being paired, and the one
 * it takes the place of. `keeps`: this television keeps a file but cannot
 * make a secret (no cryptographic generator — Vega), so the pairing service
 * makes one and hands it over with the token (edge-device pair-claim.mjs,
 * pair-status.mjs).
 */
export interface PairingIdentity extends Identity {
  readonly keeps?: true;
  readonly replaces?: { readonly deviceId: string; readonly proof: string };
}

/** What is kept in IDENTITY_PATH. That it is there at all says this television's storage keeps a file. */
interface Kept {
  readonly deviceId: string;
  /** Made here, or handed over by the pairing service; none yet on a television that cannot make one and has not been paired since. */
  readonly proof?: string;
  /** Whether a pairing has completed under this id: the next pairing is then a new television. */
  readonly paired: boolean;
  /** The identity a pairing under way is for, until its code is entered. */
  readonly next?: { readonly deviceId: string; readonly proof?: string };
}

/** A television whose storage keeps nothing: the simulator, or the card service, which only reads. */
interface Unkept {
  readonly deviceId: string;
}

export interface TelevisionIdentity {
  /** This television's id now. */
  deviceId(): Promise<string>;
  /** The secret to send with a refresh for this id, or undefined where there is none. */
  proofFor(deviceId: string): Promise<string | undefined>;
  /** Who to ask for a code as: this television, or — once it has been paired — a new one in its place. */
  forPairing(deviceId: string): Promise<PairingIdentity>;
  /**
   * The code was entered for this id: it is this television's identity from
   * now on, with the secret the pairing service handed over, if it did. True
   * once that is written down and read back — and, where the identity was
   * waiting for a secret, with the secret.
   */
  paired(deviceId: string, proof?: string): Promise<boolean>;
}

const ENCODING = 'utf8';
const SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const PROOF_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * A new secret: 32 bytes from the platform's cryptographic generator, as hex
 * (edge-device proof.mjs takes 32 to 128 such characters) — or undefined
 * where the runtime has no such generator (random.ts: Vega). Then no secret
 * is made at all, and the television is answered from its id alone, as one
 * that keeps nothing is. Said once, in the log, without the id.
 */
let saidNoGenerator = false;
const newProof = (): string | undefined => {
  const proof = secureHex(32);
  if (proof === undefined && !saidNoGenerator) {
    saidNoGenerator = true;
    console.warn('device_secret_not_made: no cryptographic generator on this runtime');
  }
  return proof;
};

function parse(raw: string | null | undefined): Kept | undefined {
  if (!raw) return undefined;
  const proofOf = (value: unknown): { proof?: string } => (typeof value === 'string' && PROOF_SHAPE.test(value) ? { proof: value } : {});
  try {
    const kept = JSON.parse(raw) as Partial<Kept> | null;
    if (!kept || typeof kept.deviceId !== 'string' || !SHAPE.test(kept.deviceId)) return undefined;
    if (kept.proof !== undefined && proofOf(kept.proof).proof === undefined) return undefined;
    const next = kept.next && typeof kept.next.deviceId === 'string' && SHAPE.test(kept.next.deviceId) ? { deviceId: kept.next.deviceId, ...proofOf(kept.next.proof) } : undefined;
    return { deviceId: kept.deviceId, ...proofOf(kept.proof), paired: kept.paired === true, ...(next ? { next } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * The kept identity; undefined where there is none. A file that is there
 * but cannot be read whole — caught half-written by the app, from the card
 * service's process — is read again a few times before it counts as none:
 * read as none, the service would ask as the id kept before secrets, which
 * after a new pairing is a television that no longer exists.
 */
async function readKept(fs: FileSystemLike, wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<Kept | undefined> {
  for (let attempt = 0; ; attempt += 1) {
    let raw: string;
    try {
      if (!(await fs.exists(IDENTITY_PATH))) return undefined;
      raw = await fs.readFileAsString(IDENTITY_PATH, ENCODING);
    } catch {
      // Storage that throws keeps nothing, now or in a moment.
      return undefined;
    }
    const kept = parse(raw);
    // Only something written, and not yet whole, is worth reading again.
    if (kept || !raw || attempt >= 3) return kept;
    await wait(50);
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
  /** A new secret, or undefined where none can be made safely (the default, `newProof`). */
  readonly generateProof?: () => string | undefined;
}

export function televisionIdentity(fs: FileSystemLike, options: IdentityOptions = {}): TelevisionIdentity {
  const writes = options.writes === true;
  const generateId = options.generateId ?? randomDeviceId;
  const generateProof = options.generateProof ?? newProof;
  /** The app's view: read, and made where it can be, once; then changed only here. */
  let mine: Promise<Kept | Unkept> | undefined;

  /**
   * What this television is. A kept identity as it is. Otherwise the id kept
   * on its own (or the simulator's), and — for the app, where storage keeps
   * a file — an identity written for it now, with a secret where one can be
   * made. Somebody holding a token that names that id was paired under it:
   * its next pairing is a new television.
   */
  const make = async (): Promise<Kept | Unkept> => {
    const kept = await readKept(fs);
    if (kept) {
      // A pairing that finished — its token written — but whose identity was not taken on (the app stopped between the
      // two): taken on now, where the secret is here to take on. Without a secret there is nothing to prove with; the
      // television is refused at its next refresh and paired again.
      if (writes && kept.next?.proof !== undefined && (await tokenNames(fs, kept.next.deviceId))) {
        const promoted: Kept = { deviceId: kept.next.deviceId, proof: kept.next.proof, paired: true };
        if (await writeKept(fs, promoted)) return promoted;
      }
      return kept;
    }
    const deviceId = await legacyDeviceId(fs, options.generateId);
    if (!writes || deviceId === SIMULATOR_DEVICE_ID) return { deviceId };
    // No cryptographic generator, no secret made here — never a guessable one. The pairing service makes it at the next pairing (`keeps`).
    const proof = generateProof();
    const made: Kept = { deviceId, ...(proof === undefined ? {} : { proof }), paired: await tokenNames(fs, deviceId) };
    return (await writeKept(fs, made)) ? made : { deviceId };
  };

  const current = (): Promise<Kept | Unkept> => {
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

  const isKept = (who: Kept | Unkept): who is Kept => 'paired' in who;
  /** How an identity is asked for a code with: its own secret, or — keeping a file but unable to make one — asking for one. */
  const asked = (who: { readonly deviceId: string; readonly proof?: string }): PairingIdentity =>
    who.proof === undefined ? { deviceId: who.deviceId, keeps: true } : { deviceId: who.deviceId, proof: who.proof };

  return {
    async deviceId() {
      return (await current()).deviceId;
    },

    async proofFor(deviceId) {
      const who = await current();
      if (!isKept(who)) return undefined;
      if (who.deviceId === deviceId) return who.proof;
      return who.next?.deviceId === deviceId ? who.next.proof : undefined;
    },

    async forPairing() {
      const who = await current();
      // The simulator, which keeps nothing, never asks for a secret: one it could not keep would lock it out at its next launch.
      if (!writes || !isKept(who)) return { deviceId: who.deviceId };
      if (!who.paired) return asked(who);
      // A new television in place of the one that was paired — the same new one for every code until one is entered.
      let next = who.next;
      if (!next) {
        const proof = generateProof();
        next = { deviceId: generateId(), ...(proof === undefined ? {} : { proof }) };
        if (!(await change({ ...who, next }))) return asked(who);
      }
      return { ...asked(next), ...(who.proof === undefined ? {} : { replaces: { deviceId: who.deviceId, proof: who.proof } }) };
    },

    async paired(deviceId, handedOver) {
      const who = await current();
      if (!writes || !isKept(who)) return false;
      const target = who.next?.deviceId === deviceId ? who.next : who.deviceId === deviceId ? who : undefined;
      if (!target) return false;
      // Its own secret if it made one; otherwise the one the pairing service made for it.
      const proof = target.proof ?? (typeof handedOver === 'string' && PROOF_SHAPE.test(handedOver) ? handedOver : undefined);
      if (target === who && who.paired && who.proof === proof) return true;
      // `change` writes, reads back, and only then makes it the identity every later question sees.
      return change({ deviceId, ...(proof === undefined ? {} : { proof }), paired: true });
    },
  };
}
