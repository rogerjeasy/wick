import { describe, expect, it } from 'vitest';
import { resolveDeviceId, SIMULATOR_DEVICE_ID, televisionIdentity } from '../deviceId.js';
import type { FileSystemLike } from '../headless/QueueStore.js';

function workingFs(): FileSystemLike {
  const files = new Map<string, string>();
  return {
    async exists(path) {
      return files.has(path) && files.get(path) !== '';
    },
    async readFileAsString(path) {
      return files.get(path) ?? '';
    },
    async writeStringToFile(path, content) {
      files.set(path, content);
      return content.length;
    },
  };
}

/** The Vega Virtual Device: no data root, so every write is refused (FRICTION.md FL-013). */
function refusingFs(): FileSystemLike {
  return {
    async exists() {
      return false;
    },
    async readFileAsString() {
      return '';
    },
    async writeStringToFile() {
      throw new Error('[com.amazon.kepler.io.IoError]: ');
    },
  };
}

describe('resolveDeviceId', () => {
  it('gives a television whose storage works an id of its own, and the same one every launch', async () => {
    const fs = workingFs();

    const first = await resolveDeviceId(fs, () => 'wick-abc123');
    const second = await resolveDeviceId(fs, () => 'wick-different');

    expect(first).toBe('wick-abc123');
    expect(second).toBe('wick-abc123');
  });

  it('gives two televisions different ids, so two homes never share one', async () => {
    const a = await resolveDeviceId(workingFs());
    const b = await resolveDeviceId(workingFs());

    expect(a).not.toBe(b);
    expect(a).not.toBe(SIMULATOR_DEVICE_ID);
  });

  it('falls back to the simulator’s fixed id when storage cannot keep one — a new id every launch would unpair it every launch', async () => {
    expect(await resolveDeviceId(refusingFs(), () => 'wick-lost-on-restart')).toBe(SIMULATOR_DEVICE_ID);
  });

  it('falls back the same way when storage throws on read', async () => {
    const fs = refusingFs();
    fs.exists = async () => {
      throw new Error('[com.amazon.kepler.io.IoError]: ');
    };

    expect(await resolveDeviceId(fs)).toBe(SIMULATOR_DEVICE_ID);
  });
});

// INV-1: the id is not a secret. A television that can keep a file keeps a
// secret beside it, proves every refresh with it, and becomes a new
// television each time it is paired again.
describe('televisionIdentity — the secret, and a new id at every new pairing', () => {
  const ids = (...list: string[]) => {
    const queue = [...list];
    return () => queue.shift() ?? 'wick-ran-out';
  };
  const proofs = (...list: string[]) => {
    const queue = [...list];
    return () => queue.shift() ?? 'p'.repeat(64);
  };
  const P1 = '1'.repeat(64);
  const P2 = '2'.repeat(64);

  it('makes a secret where storage keeps one, keeps it across launches, and lets the card service read it', async () => {
    const fs = workingFs();
    const app = televisionIdentity(fs, { writes: true, generateId: ids('wick-one'), generateProof: proofs(P1) });

    expect(await app.deviceId()).toBe('wick-one');
    expect(await app.proofFor('wick-one')).toBe(P1);

    const nextLaunch = televisionIdentity(fs, { writes: true, generateProof: proofs(P2) });
    expect(await nextLaunch.proofFor('wick-one')).toBe(P1);
    expect(await televisionIdentity(fs).proofFor('wick-one')).toBe(P1);
    expect(await resolveDeviceId(fs)).toBe('wick-one');
    // Not for any other id.
    expect(await app.proofFor('wick-tv')).toBeUndefined();
  });

  it('makes nothing on a television that keeps nothing: the simulator has its fixed id, no secret, and never becomes another', async () => {
    const app = televisionIdentity(refusingFs(), { writes: true });

    expect(await app.deviceId()).toBe(SIMULATOR_DEVICE_ID);
    expect(await app.proofFor(SIMULATOR_DEVICE_ID)).toBeUndefined();
    expect(await app.forPairing(SIMULATOR_DEVICE_ID)).toEqual({ deviceId: SIMULATOR_DEVICE_ID });
    await app.paired(SIMULATOR_DEVICE_ID);
    expect(await app.forPairing(SIMULATOR_DEVICE_ID)).toEqual({ deviceId: SIMULATOR_DEVICE_ID });
  });

  it('makes no secret it cannot read back: one that would be gone next launch would lock the television out', async () => {
    const fs = workingFs();
    await resolveDeviceId(fs, () => 'wick-one');
    const write = fs.writeStringToFile.bind(fs);
    fs.writeStringToFile = async (path, content, encoding) => (path.endsWith('wick-identity.json') ? write(path, '', encoding) : write(path, content, encoding));

    const app = televisionIdentity(fs, { writes: true });
    expect(await app.proofFor('wick-one')).toBeUndefined();
    expect(await app.forPairing('wick-one')).toEqual({ deviceId: 'wick-one' });
  });

  it('pairs a television never paired as itself, with its secret — and the next time, as a new one in its place', async () => {
    const app = televisionIdentity(workingFs(), { writes: true, generateId: ids('wick-one', 'wick-two'), generateProof: proofs(P1, P2) });

    expect(await app.forPairing('wick-one')).toEqual({ deviceId: 'wick-one', proof: P1 });
    await app.paired('wick-one');

    const again = await app.forPairing('wick-one');
    expect(again).toEqual({ deviceId: 'wick-two', proof: P2, replaces: { deviceId: 'wick-one', proof: P1 } });
    // The same new television for every code, until one is entered.
    expect(await app.forPairing('wick-one')).toEqual(again);
  });

  it('leaves the television exactly as it was when no code is entered — this launch, and the next', async () => {
    const fs = workingFs();
    const app = televisionIdentity(fs, { writes: true, generateId: ids('wick-one', 'wick-two'), generateProof: proofs(P1, P2) });
    await app.forPairing('wick-one');
    await app.paired('wick-one');
    await app.forPairing('wick-one');

    expect(await app.deviceId()).toBe('wick-one');
    expect(await app.proofFor('wick-one')).toBe(P1);
    expect(await televisionIdentity(fs, { writes: true }).deviceId()).toBe('wick-one');
    expect(await resolveDeviceId(fs)).toBe('wick-one');
  });

  it('takes on the new identity once its code is entered, and the old id proves nothing any more', async () => {
    const fs = workingFs();
    const app = televisionIdentity(fs, { writes: true, generateId: ids('wick-one', 'wick-two'), generateProof: proofs(P1, P2) });
    await app.forPairing('wick-one');
    await app.paired('wick-one');
    await app.forPairing('wick-one');

    await app.paired('wick-two');

    expect(await app.deviceId()).toBe('wick-two');
    expect(await app.proofFor('wick-two')).toBe(P2);
    expect(await app.proofFor('wick-one')).toBeUndefined();
    expect(await resolveDeviceId(fs)).toBe('wick-two');
    expect(await televisionIdentity(fs).proofFor('wick-two')).toBe(P2);
  });

  it('gives a television paired before secrets one now, and counts it as paired when it holds a token for its id', async () => {
    const fs = workingFs();
    await resolveDeviceId(fs, () => 'wick-legacy');
    await fs.writeStringToFile('/data/wick-token.json', JSON.stringify({ jwt: 'j', deviceId: 'wick-legacy', householdId: 'h', expiresAt: 1 }), 'utf8');

    const app = televisionIdentity(fs, { writes: true, generateId: ids('wick-new'), generateProof: proofs(P1, P2) });

    expect(await app.deviceId()).toBe('wick-legacy');
    expect(await app.proofFor('wick-legacy')).toBe(P1);
    expect(await app.forPairing('wick-legacy')).toEqual({ deviceId: 'wick-new', proof: P2, replaces: { deviceId: 'wick-legacy', proof: P1 } });
  });

  it('counts one paired before secrets without a token for its id as never paired', async () => {
    const fs = workingFs();
    await resolveDeviceId(fs, () => 'wick-legacy');

    const app = televisionIdentity(fs, { writes: true, generateProof: proofs(P1) });

    expect(await app.forPairing('wick-legacy')).toEqual({ deviceId: 'wick-legacy', proof: P1 });
  });

  it('is only read by the card service: it makes no secret and changes nothing', async () => {
    const fs = workingFs();
    await resolveDeviceId(fs, () => 'wick-legacy');
    const service = televisionIdentity(fs);

    expect(await service.proofFor('wick-legacy')).toBeUndefined();
    expect(await service.forPairing('wick-legacy')).toEqual({ deviceId: 'wick-legacy' });
    expect(await fs.exists('/data/wick-identity.json')).toBe(false);
  });

  it('makes ids and secrets from randomness alone — no clock in them to guess from', async () => {
    const app = televisionIdentity(workingFs(), { writes: true });
    const id = await app.deviceId();

    expect(id).toMatch(/^wick-[0-9a-f]{32}$/);
    expect(await app.proofFor(id)).toMatch(/^[0-9a-f]{64}$/);
  });
});
