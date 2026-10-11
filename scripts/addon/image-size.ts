/**
 * The pixel size of a PNG, from its first 24 bytes. A manifest says each icon
 * is 72x72, 64x64 and so on; `alexa-ai deploy` is documented to refuse a file
 * that is not the size it claims (docs/icons/README.md), so the claim is
 * checked against the file itself.
 *
 * PNG only: every image Wick publishes is one. A JPEG or WEBP is reported as
 * unread, never as passing.
 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4). */
const PNG_HEADER_BYTES = 24;

export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

export function pngSize(bytes: Uint8Array): PixelSize | undefined {
  if (bytes.length < PNG_HEADER_BYTES) return undefined;
  if (PNG_SIGNATURE.some((byte, i) => bytes[i] !== byte)) return undefined;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** "72x72" for a size, the way the manifest writes it. */
export const sizeLabel = (size: PixelSize): string => `${size.width}x${size.height}`;
