import { describe, expect, it } from 'vitest';
import { resolveDeviceId, SIMULATOR_DEVICE_ID } from '../deviceId.js';
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
