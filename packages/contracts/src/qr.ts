/**
 * A QR code for the pairing screen: the family app's link with the code in
 * it, so whoever sets up her television can point a phone at the screen
 * instead of typing an address read off it.
 *
 * Small on purpose, and with no dependency: the television runs on Vega, on
 * Fire OS and in a browser tab, and each would otherwise need its own copy of
 * a library for one picture. It does one thing, the way ISO/IEC 18004 says:
 * byte mode, error correction level M (about 15% of the code can be lost and
 * it still reads), versions 1 to 6 — up to 106 bytes, twice the length of a
 * pairing link. Longer text gets no code (`undefined`), and the screen shows
 * the address alone, as it always did.
 *
 * The answer is the grid of modules, row by row, `true` for dark, without
 * the quiet zone: whoever draws it leaves four light modules all round.
 */

/** Error correction level M, by version: the error-correction codewords per block, and the blocks. All blocks are the same length up to version 6. */
const VERSIONS: readonly { readonly ecPerBlock: number; readonly blocks: number; readonly total: number; readonly align?: number }[] = [
  { ecPerBlock: 10, blocks: 1, total: 26 },
  { ecPerBlock: 16, blocks: 1, total: 44, align: 18 },
  { ecPerBlock: 26, blocks: 1, total: 70, align: 22 },
  { ecPerBlock: 18, blocks: 2, total: 100, align: 26 },
  { ecPerBlock: 24, blocks: 2, total: 134, align: 30 },
  { ecPerBlock: 16, blocks: 4, total: 172, align: 34 },
];

/** Level M's two bits in the format information (L is 01, M 00, Q 11, H 10). */
const LEVEL_M = 0b00;

/** The data codewords a version carries at level M. */
const dataCodewords = (v: (typeof VERSIONS)[number]): number => v.total - v.ecPerBlock * v.blocks;

/** The most bytes a version carries: four bits of mode, eight of length, eight a byte. */
export const QR_MAX_BYTES = dataCodewords(VERSIONS[VERSIONS.length - 1]!) - 2;

/** Multiplication in GF(2^8), modulo x^8 + x^4 + x^3 + x^2 + 1. */
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The Reed–Solomon generator polynomial of this degree, highest coefficient first and the leading 1 left out. */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The error-correction codewords for one block of data. */
export function rsRemainder(data: readonly number[], degree: number): number[] {
  const divisor = rsDivisor(degree);
  const result = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i]! ^= gfMultiply(coef, factor)));
  }
  return result;
}

/** UTF-8, by hand: not every television's JavaScript has TextEncoder. */
function utf8(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** The data codewords: mode, length, the bytes, a terminator, and padding to the version's length. */
function dataBytes(bytes: readonly number[], capacity: number): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, 8);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  for (let pad = 0xec; out.length < capacity; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Data and error correction, block by block, then interleaved as the symbol carries them. */
function codewords(data: readonly number[], v: (typeof VERSIONS)[number]): number[] {
  const perBlock = data.length / v.blocks;
  const blocks = Array.from({ length: v.blocks }, (_, i) => data.slice(i * perBlock, (i + 1) * perBlock));
  const ecc = blocks.map((block) => rsRemainder(block, v.ecPerBlock));
  const out: number[] = [];
  for (let i = 0; i < perBlock; i++) for (const block of blocks) out.push(block[i]!);
  for (let i = 0; i < v.ecPerBlock; i++) for (const block of ecc) out.push(block[i]!);
  return out;
}

/** The fifteen format bits for level M and this mask: BCH(15,5), then masked so they are never all light. */
export function formatBits(mask: number): number {
  const data = (LEVEL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** A symbol being drawn: its modules, and which of them are the fixed patterns rather than data. */
interface Grid {
  readonly size: number;
  readonly dark: boolean[][];
  readonly fixed: boolean[][];
}

function blank(size: number): Grid {
  return { size, dark: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)), fixed: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)) };
}

function setFixed(s: Grid, x: number, y: number, dark: boolean): void {
  s.dark[y]![x] = dark;
  s.fixed[y]![x] = true;
}

/** Finders, their separators, the timing lines, the alignment pattern, and the format areas (drawn with mask 0 for now). */
function drawFixed(s: Grid, align: number | undefined): void {
  const { size } = s;
  for (let i = 0; i < size; i++) {
    setFixed(s, 6, i, i % 2 === 0);
    setFixed(s, i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) setFixed(s, x, y, ring !== 2 && ring !== 4);
      }
    }
  }
  if (align !== undefined) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFixed(s, align + dx, align + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  drawFormat(s, 0);
}

/** The format bits, twice, and the one module that is always dark. */
function drawFormat(s: Grid, mask: number): void {
  const { size } = s;
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) setFixed(s, 8, i, bit(i));
  setFixed(s, 8, 7, bit(6));
  setFixed(s, 8, 8, bit(7));
  setFixed(s, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFixed(s, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) setFixed(s, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFixed(s, 8, size - 15 + i, bit(i));
  setFixed(s, 8, size - 8, true);
}

/** The order the data modules are read in: two columns at a time, from the right, up then down, stepping over the timing column. */
export function dataModuleOrder(fixed: readonly (readonly boolean[])[]): [x: number, y: number][] {
  const size = fixed.length;
  const order: [number, number][] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fixed[y]![x]) order.push([x, y]);
      }
    }
  }
  return order;
}

function placeData(s: Grid, data: readonly number[]): void {
  dataModuleOrder(s.fixed).forEach(([x, y], i) => {
    // What is left after the last codeword (the remainder bits) stays light.
    s.dark[y]![x] = i < data.length * 8 && ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
  });
}

function applyMask(s: Grid, mask: number): void {
  const flip = MASKS[mask]!;
  for (let y = 0; y < s.size; y++) for (let x = 0; x < s.size; x++) if (!s.fixed[y]![x] && flip(x, y)) s.dark[y]![x] = !s.dark[y]![x];
}

/** The four penalty rules a mask is chosen by: runs, blocks, finder-like patterns, and the balance of dark and light. */
function penalty(dark: readonly (readonly boolean[])[]): number {
  const size = dark.length;
  const at = (x: number, y: number, byRow: boolean) => (byRow ? dark[y]![x]! : dark[x]![y]!);
  const FINDER_LIKE = [true, false, true, true, true, false, true];
  let score = 0;
  for (const byRow of [true, false]) {
    for (let y = 0; y < size; y++) {
      let run = 1;
      for (let x = 1; x <= size; x++) {
        if (x < size && at(x, y, byRow) === at(x - 1, y, byRow)) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      for (let x = 0; x + 7 <= size; x++) {
        if (!FINDER_LIKE.every((d, i) => at(x + i, y, byRow) === d)) continue;
        const lightBefore = [1, 2, 3, 4].every((i) => x - i < 0 || !at(x - i, y, byRow));
        const lightAfter = [0, 1, 2, 3].every((i) => x + 7 + i >= size || !at(x + 7 + i, y, byRow));
        if (lightBefore || lightAfter) score += 40;
      }
    }
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const d = dark[y]![x];
      if (d === dark[y]![x + 1] && d === dark[y + 1]![x] && d === dark[y + 1]![x + 1]) score += 3;
    }
  }
  const darkCount = dark.reduce((n, row) => n + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs(darkCount * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

/** The QR code for `text`, as rows of modules (`true` dark), or undefined when it is longer than version 6 carries at level M. */
export function qrModules(text: string): boolean[][] | undefined {
  const bytes = utf8(text);
  const index = VERSIONS.findIndex((v) => bytes.length <= dataCodewords(v) - 2);
  if (index < 0) return undefined;
  const version = VERSIONS[index]!;
  const size = 17 + 4 * (index + 1);
  const all = codewords(dataBytes(bytes, dataCodewords(version)), version);

  let best: { score: number; dark: boolean[][] } | undefined;
  for (let mask = 0; mask < 8; mask++) {
    const s = blank(size);
    drawFixed(s, version.align);
    placeData(s, all);
    applyMask(s, mask);
    drawFormat(s, mask);
    const score = penalty(s.dark);
    if (!best || score < best.score) best = { score, dark: s.dark };
  }
  return best!.dark;
}

/** Each row's dark modules as runs: `[start, length]`. Drawn as one block a run, a code is a few hundred blocks, not a thousand squares. */
export function qrRuns(modules: readonly (readonly boolean[])[]): [start: number, length: number][][] {
  return modules.map((row) => {
    const runs: [number, number][] = [];
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      const last = runs[runs.length - 1];
      if (last && last[0] + last[1] === x) last[1]++;
      else runs.push([x, 1]);
    }
    return runs;
  });
}
