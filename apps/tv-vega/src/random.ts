/**
 * Random text for a television's id and its secret (deviceId.ts).
 *
 * A secret is made only from the platform's cryptographic generator,
 * `crypto.getRandomValues`, and never from anything else (`secureHex`):
 *
 *   - Fire OS: installed by react-native-get-random-values, which
 *     apps/tv-fireos/index.js loads before the app (Android's SecureRandom).
 *   - The browser television has its own (apps/ops-console/tv-core.js).
 *   - Vega: React Native for Vega gives the JavaScript runtime none, and the
 *     SDK's only crypto package is an Expo module (`@amazon-devices/
 *     expo-crypto`, which needs Expo). So a Vega television makes no secret
 *     of its own: where its disk keeps a file it asks the pairing service to
 *     make one (deviceId.ts `keeps`), and where it keeps nothing — the
 *     simulator — it is answered from its id alone, the documented exception
 *     (AGENTS.md INV-1). Fail closed: a guessable secret would look like
 *     proof and be none.
 *
 * An id is a label, not a credential, so it may fall back to `Math.random`
 * where there is no generator (`randomHex`). No native module is imported
 * here: a native import at load time is what CardService.ts's header warns
 * about.
 */
type RandomSource = { readonly getRandomValues?: (array: Uint8Array) => Uint8Array };

/** The platform's cryptographic generator, or undefined where the runtime has none. */
export type SecureRandom = ((array: Uint8Array) => Uint8Array) | undefined;

export function platformRandom(): SecureRandom {
  const source = (globalThis as { readonly crypto?: RandomSource }).crypto;
  return typeof source?.getRandomValues === 'function' ? (array) => source.getRandomValues!(array) : undefined;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** `length` bytes from the cryptographic generator, as hex — or undefined where there is none. Never anything weaker. */
/** `random`: the generator to use — by default the platform's; `null` for none. */
export function secureHex(length: number, random: SecureRandom | null = platformRandom()): string | undefined {
  if (!random) return undefined;
  try {
    return hex(random(new Uint8Array(length)));
  } catch {
    // A generator that is there but cannot answer (its native half missing) is no generator.
    return undefined;
  }
}

/** `length` random bytes as hex, for an id: the cryptographic generator where there is one, else Math.random. Never for a secret. */
export function randomHex(length: number, random: SecureRandom | null = platformRandom()): string {
  const secure = secureHex(length, random);
  if (secure !== undefined) return secure;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = Math.floor(Math.random() * 256) & 0xff;
  return hex(out);
}
