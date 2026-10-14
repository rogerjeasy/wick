import { describe, expect, it, vi } from 'vitest';
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

// Vega has no cryptographic generator (random.ts). A television there that
// keeps a file asks the pairing service for its secret instead, and keeps
// the one handed over; it never makes a guessable one.
describe('televisionIdentity — no cryptographic generator', () => {
  const HANDED = 'h'.repeat(64);
  const SECOND = 'k'.repeat(64);

  it('asks the pairing service for a secret, keeps the one handed over with the token, and proves every refresh with it', async () => {
    const fs = workingFs();
    const app = televisionIdentity(fs, { writes: true, generateId: () => 'wick-one', generateProof: () => undefined });

    expect(await app.proofFor('wick-one')).toBeUndefined();
    expect(await app.forPairing('wick-one')).toEqual({ deviceId: 'wick-one', keeps: true });

    await app.paired('wick-one', HANDED);

    expect(await app.proofFor('wick-one')).toBe(HANDED);
    expect(await televisionIdentity(fs).proofFor('wick-one')).toBe(HANDED);
    expect(await televisionIdentity(fs, { writes: true }).proofFor('wick-one')).toBe(HANDED);
  });

  it('paired again, asks as a new television for a new secret, and proves the one it replaces with the one it was handed', async () => {
    const ids = ['wick-one', 'wick-two'];
    const app = televisionIdentity(workingFs(), { writes: true, generateId: () => ids.shift()!, generateProof: () => undefined });
    await app.forPairing(await app.deviceId());
    await app.paired('wick-one', HANDED);

    expect(await app.forPairing('wick-one')).toEqual({ deviceId: 'wick-two', keeps: true, replaces: { deviceId: 'wick-one', proof: HANDED } });
    await app.paired('wick-two', SECOND);
    expect(await app.deviceId()).toBe('wick-two');
    expect(await app.proofFor('wick-two')).toBe(SECOND);
    expect(await app.proofFor('wick-one')).toBeUndefined();
  });

  it('takes no secret it was not asking for, and nothing that is not shaped like one', async () => {
    const own = televisionIdentity(workingFs(), { writes: true, generateId: () => 'wick-one', generateProof: () => '1'.repeat(64) });
    await own.paired(await own.deviceId(), HANDED);
    expect(await own.proofFor('wick-one')).toBe('1'.repeat(64));

    const asking = televisionIdentity(workingFs(), { writes: true, generateId: () => 'wick-one', generateProof: () => undefined });
    await asking.paired(await asking.deviceId(), 'short');
    expect(await asking.proofFor('wick-one')).toBeUndefined();
  });

  it('never asks for one on a television that keeps nothing: the simulator would be locked out at its next launch', async () => {
    const app = televisionIdentity(refusingFs(), { writes: true, generateProof: () => undefined });

    expect(await app.forPairing(SIMULATOR_DEVICE_ID)).toEqual({ deviceId: SIMULATOR_DEVICE_ID });
    await app.paired(SIMULATOR_DEVICE_ID, HANDED);
    expect(await app.proofFor(SIMULATOR_DEVICE_ID)).toBeUndefined();
  });

  it('never asks for one from the card service, which only reads', async () => {
    const fs = workingFs();
    await resolveDeviceId(fs, () => 'wick-one');
    expect(await televisionIdentity(fs, { generateProof: () => undefined }).forPairing('wick-one')).toEqual({ deviceId: 'wick-one' });
  });

  it('by default, on a runtime without crypto.getRandomValues, and says so once', async () => {
    const had = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
      const app = televisionIdentity(workingFs(), { writes: true, generateId: () => 'wick-one' });
      expect(await app.proofFor(await app.deviceId())).toBeUndefined();
      await televisionIdentity(workingFs(), { writes: true }).deviceId();
      expect(warn.mock.calls.filter(([line]) => String(line).startsWith('device_secret_not_made'))).toHaveLength(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('wick-one');
    } finally {
      if (had) Object.defineProperty(globalThis, 'crypto', had);
      warn.mockRestore();
    }
  });

  it('asks for a new secret when, paired again, it cannot make one — and proves the old one with its own', async () => {
    let generator = true;
    const ids = ['wick-one', 'wick-two'];
    const app = televisionIdentity(workingFs(), { writes: true, generateId: () => ids.shift()!, generateProof: () => (generator ? '1'.repeat(64) : undefined) });
    const id = await app.deviceId();
    await app.paired(id);
    generator = false;

    expect(await app.forPairing(id)).toEqual({ deviceId: 'wick-two', keeps: true, replaces: { deviceId: 'wick-one', proof: '1'.repeat(64) } });
  });
});

// What the app and the card service see once the identity has changed.
describe('televisionIdentity — never a stale identity', () => {
  const HANDED = 'h'.repeat(64);

  it('(1) every later question sees the new id and the handed-over secret at once, in this process and the card service’s', async () => {
    const fs = workingFs();
    const ids = ['wick-one', 'wick-two'];
    const app = televisionIdentity(fs, { writes: true, generateId: () => ids.shift()!, generateProof: () => undefined });
    await app.paired(await app.deviceId(), 'f'.repeat(64));
    expect((await app.forPairing('wick-one')).deviceId).toBe('wick-two');

    expect(await app.paired('wick-two', HANDED)).toBe(true);

    expect(await app.deviceId()).toBe('wick-two');
    expect(await app.proofFor('wick-two')).toBe(HANDED);
    expect(await app.proofFor('wick-one')).toBeUndefined();
    expect(await app.forPairing('wick-two')).toMatchObject({ deviceId: expect.not.stringMatching(/^wick-(one|two)$/) as unknown as string, replaces: { deviceId: 'wick-two', proof: HANDED } });
    const service = televisionIdentity(fs);
    expect(await service.deviceId()).toBe('wick-two');
    expect(await service.proofFor('wick-two')).toBe(HANDED);
  });

  it('(2) the card service reads a file caught half-written again, rather than taking the id kept before secrets', async () => {
    const fs = workingFs();
    const app = televisionIdentity(fs, { writes: true, generateId: () => 'wick-one', generateProof: () => '1'.repeat(64) });
    await app.deviceId();
    const whole = await fs.readFileAsString('/data/wick-identity.json', 'utf8');
    let reads = 0;
    const read = fs.readFileAsString.bind(fs);
    fs.readFileAsString = async (path, encoding) => {
      if (path.endsWith('wick-identity.json') && (reads += 1) === 1) return whole.slice(0, 10);
      return read(path, encoding);
    };

    expect(await televisionIdentity(fs).proofFor('wick-one')).toBe('1'.repeat(64));
    expect(reads).toBeGreaterThan(1);
  });

  it('(3) says when a handed-over secret could not be written down — and keeps nothing it could not read back', async () => {
    const fs = workingFs();
    const app = televisionIdentity(fs, { writes: true, generateId: () => 'wick-one', generateProof: () => undefined });
    await app.deviceId();
    fs.writeStringToFile = async () => {
      throw new Error('[com.amazon.kepler.io.IoError]: ');
    };

    expect(await app.paired('wick-one', HANDED)).toBe(false);
    expect(await app.proofFor('wick-one')).toBeUndefined();
    // Asked for a code again, it asks under the same identity, for a new secret.
    expect(await app.forPairing('wick-one')).toEqual({ deviceId: 'wick-one', keeps: true });
  });

  it('(3) takes on a pairing whose token was written but whose identity was not, at the next launch, where its secret is here', async () => {
    const fs = workingFs();
    const ids = ['wick-one', 'wick-two'];
    const proofs = ['1'.repeat(64), '2'.repeat(64)];
    const app = televisionIdentity(fs, { writes: true, generateId: () => ids.shift()!, generateProof: () => proofs.shift() });
    await app.paired(await app.deviceId());
    await app.forPairing('wick-one');
    // The app stopped after the new token was written, before `paired`.
    await fs.writeStringToFile('/data/wick-token.json', JSON.stringify({ jwt: 'j', deviceId: 'wick-two', householdId: 'h', expiresAt: 1 }), 'utf8');

    const nextLaunch = televisionIdentity(fs, { writes: true });
    expect(await nextLaunch.deviceId()).toBe('wick-two');
    expect(await nextLaunch.proofFor('wick-two')).toBe('2'.repeat(64));
  });

  it('(4) a pairing begun and never finished changes nothing: no secret moves, nothing is enrolled or replaced by it', async () => {
    const fs = workingFs();
    const ids = ['wick-one', 'wick-two'];
    const proofs = ['1'.repeat(64), '2'.repeat(64)];
    const app = televisionIdentity(fs, { writes: true, generateId: () => ids.shift()!, generateProof: () => proofs.shift() });
    await app.paired(await app.deviceId());
    const begun = await app.forPairing('wick-one');

    // A token for the old id still comes and goes: the pairing begun is not taken on by it.
    expect(await app.paired('wick-one')).toBe(true);
    // An id it never asked under is nobody's.
    expect(await app.paired('wick-nobody', HANDED)).toBe(false);
    expect(await app.deviceId()).toBe('wick-one');
    expect(await app.proofFor('wick-one')).toBe('1'.repeat(64));
    // The same new television for the next code, still naming the old one by the old one's own secret.
    expect(await televisionIdentity(fs, { writes: true }).forPairing('wick-one')).toEqual(begun);
    expect(begun).toEqual({ deviceId: 'wick-two', proof: '2'.repeat(64), replaces: { deviceId: 'wick-one', proof: '1'.repeat(64) } });
  });
});
