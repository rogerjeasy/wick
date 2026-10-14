/**
 * Random text for a television's id and its secret (deviceId.ts).
 *
 * The platform's cryptographic generator (`crypto.getRandomValues`) when the
 * JavaScript runtime has one — a browser does, and some React Native
 * runtimes do. Where it has none, `Math.random`: not cryptographic, so the
 * secret it makes is weaker than it looks — but it never leaves the
 * television except over TLS to the pairing service, the server keeps only
 * its hash, and so it can only be guessed one HTTPS request at a time
 * (edge-device proof.mjs). No native module is imported for it: a native
 * import at load time is what CardService.ts's header warns about.
 */
type RandomSource = { readonly getRandomValues?: (array: Uint8Array) => Uint8Array };

export type RandomBytes = (length: number) => Uint8Array;

export const randomBytes: RandomBytes = (length) => {
  const out = new Uint8Array(length);
  const source = (globalThis as { readonly crypto?: RandomSource }).crypto;
  if (typeof source?.getRandomValues === 'function') {
    source.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < length; i += 1) out[i] = Math.floor(Math.random() * 256) & 0xff;
  return out;
};

/** `length` random bytes as hex: twice as many characters, safe in a file name, a URL and JSON. */
export function randomHex(length: number, bytes: RandomBytes = randomBytes): string {
  return Array.from(bytes(length), (b) => b.toString(16).padStart(2, '0')).join('');
}
