import { describe, expect, it, afterEach } from 'vitest';
import doOnInstall, { __setOnInstallTestDeps, loadOrCreateDeviceId } from '../OnInstallTask.js';
import type { FileSystemLike } from '../QueueStore.js';

function fakeFs(): FileSystemLike {
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

afterEach(() => {
  __setOnInstallTestDeps(null);
});

describe('doOnInstall', () => {
  it('generates and persists a device id on first run', async () => {
    const fs = fakeFs();
    __setOnInstallTestDeps({ fs, generateId: () => 'generated-id' });

    await doOnInstall();

    expect(await loadOrCreateDeviceId(fs, () => 'should-not-be-used')).toBe('generated-id');
  });

  it('is idempotent — a second run keeps the id already persisted', async () => {
    const fs = fakeFs();
    let calls = 0;
    const generateId = () => {
      calls += 1;
      return `id-${calls}`;
    };
    __setOnInstallTestDeps({ fs, generateId });

    await doOnInstall();
    await doOnInstall();

    expect(calls).toBe(1);
    expect(await loadOrCreateDeviceId(fs, () => 'unused')).toBe('id-1');
  });
});

describe('loadOrCreateDeviceId', () => {
  it('creates one when none exists', async () => {
    const fs = fakeFs();
    const id = await loadOrCreateDeviceId(fs, () => 'fresh-id');
    expect(id).toBe('fresh-id');
  });

  it('returns the existing id rather than generating a new one', async () => {
    const fs = fakeFs();
    await fs.writeStringToFile('/wick/deviceId.json', 'existing-id', 'utf8');
    const id = await loadOrCreateDeviceId(fs, () => 'should-not-be-used');
    expect(id).toBe('existing-id');
  });
});
