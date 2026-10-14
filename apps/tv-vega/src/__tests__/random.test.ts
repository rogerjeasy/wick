import { describe, expect, it } from 'vitest';
import { platformRandom, randomHex, secureHex } from '../random.js';

// INV-1: a television's secret comes from a cryptographic generator or not at all.
describe('random — where a television’s secret may come from', () => {
  const fixed = (value: number) => (array: Uint8Array) => array.fill(value);

  it('makes a secret from the platform’s generator', () => {
    expect(secureHex(4, fixed(0xab))).toBe('abababab');
    expect(secureHex(32)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('makes no secret at all where the runtime has no generator — never one from Math.random', () => {
    const original = Math.random;
    let asked = 0;
    Math.random = () => {
      asked += 1;
      return 0.5;
    };
    try {
      expect(secureHex(32, null)).toBeUndefined();
      expect(asked).toBe(0);
    } finally {
      Math.random = original;
    }
  });

  it('makes none where the generator is there but cannot answer — its native half missing', () => {
    const broken = () => {
      throw new Error("TurboModuleRegistry.getEnforcing(...): 'RNGetRandomValues' could not be found");
    };
    expect(secureHex(32, broken)).toBeUndefined();
  });

  it('still makes an id without one: an id is a label, not a credential', () => {
    expect(randomHex(16, null)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(2, fixed(1))).toBe('0101');
  });

  it('finds the generator on globalThis.crypto, and says when there is none', () => {
    const had = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
      expect(platformRandom()).toBeUndefined();
      Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: fixed(7) }, configurable: true });
      expect(secureHex(1)).toBe('07');
    } finally {
      if (had) Object.defineProperty(globalThis, 'crypto', had);
    }
  });
});
