import { describe, expect, it } from 'vitest';
import { QR_MAX_BYTES, dataModuleOrder, formatBits, qrModules, qrRuns, rsRemainder } from '../qr.js';

/**
 * The pairing link's symbol, as an independent decoder (jsQR 1.4.0) read it
 * back to the same link when this was written. Held here so a change to the
 * encoder that alters it is seen, and checked again before it is accepted.
 */
const PAIRING_LINK = 'https://dmaz25jvryojp.cloudfront.net/?pair=448024';
const GOLDEN = [
  '#######.##..###..##.##..#.#######',
  '#.....#.###..##...###.#.#.#.....#',
  '#.###.#.#..####.#..#.####.#.###.#',
  '#.###.#..##...#.#.#.###...#.###.#',
  '#.###.#.#...##.##....##.#.#.###.#',
  '#.....#...#..####..#...##.#.....#',
  '#######.#.#.#.#.#.#.#.#.#.#######',
  '...........#.#.##.#...#..........',
  '#..#######....#..#..#....#..#.###',
  '#....#.#.##.####.###.####...###..',
  '.##.#.#..#..##.#....##.##.#.#####',
  '#.##.#.#.#####.#..##..#.#..#..#.#',
  '#...#.#...####.#.#....#...#......',
  '#####..#.#.##.#...########.#.#...',
  '...#.##.#.##...#.####.#...#......',
  '#####..#.#..#.#.#...#.#..#.#.##.#',
  '.####.###..#..##....#.#..#####...',
  '..#..#..##.#..##.####.....#.#.#.#',
  '..#..##.####.#.#####.###.###.####',
  '.#..##.###...##.#.......#.#.#####',
  '.##..##.#..##..##.#...#......#...',
  '####.#.###.##....#.....##...###..',
  '#.##.###.#.##....#.##.#####.#.###',
  '#..##..#.#.##.##.####.#.#..#..##.',
  '##.##.#...###.#.#...#..######..##',
  '........###....####...#.#...#.#..',
  '#######.######.#.#.##.###.#.#.#..',
  '#.....#.#.##.#...##.#.###...###..',
  '#.###.#.###.##.###.##..######..#.',
  '#.###.#.#...#...#.#.....##.#..###',
  '#.###.#..#.#.###...##.#..#.######',
  '#.....#...#.#.#....#...#.#.##.###',
  '#######.#####.##.#.##..##..##....',
];

const drawn = (m: readonly (readonly boolean[])[]) => m.map((row) => row.map((d) => (d ? '#' : '.')).join(''));

/** Which fixed patterns a symbol of this size has: the same rule the encoder draws by, kept apart from it. */
function fixedOf(size: number): boolean[][] {
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x: number, y: number) => x >= 0 && y >= 0 && x < size && y < size && (fixed[y]![x] = true);
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (const [x0, y0] of [[0, 0], [size - 8, 0], [0, size - 8]] as const) for (let y = y0; y < y0 + 8; y++) for (let x = x0; x < x0 + 8; x++) mark(x, y);
  const version = (size - 17) / 4;
  if (version >= 2) for (let y = size - 9; y <= size - 5; y++) for (let x = size - 9; x <= size - 5; x++) mark(x, y);
  for (let i = 0; i <= 8; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(size - 1 - i, 8); mark(8, size - 1 - i); }
  return fixed;
}

const BLOCKS: Record<number, [ecPerBlock: number, blocks: number, total: number]> = { 1: [10, 1, 26], 2: [16, 1, 44], 3: [26, 1, 70], 4: [18, 2, 100], 5: [24, 2, 134], 6: [16, 4, 172] };
const MASKS = [
  (x: number, y: number) => (x + y) % 2 === 0,
  (_x: number, y: number) => y % 2 === 0,
  (x: number) => x % 3 === 0,
  (x: number, y: number) => (x + y) % 3 === 0,
  (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Reads a symbol back as a reader would: its format, its mask, its codewords, their error correction, and the bytes. */
function readBack(m: readonly (readonly boolean[])[]): { text: string; mask: number; eccOk: boolean; formatCopiesAgree: boolean } {
  const size = m.length;
  const version = (size - 17) / 4;
  let first = 0;
  let second = 0;
  for (let i = 0; i <= 5; i++) first |= (m[i]![8] ? 1 : 0) << i;
  first |= (m[7]![8] ? 1 : 0) << 6;
  first |= (m[8]![8] ? 1 : 0) << 7;
  first |= (m[8]![7] ? 1 : 0) << 8;
  for (let i = 9; i < 15; i++) first |= (m[8]![14 - i] ? 1 : 0) << i;
  for (let i = 0; i < 8; i++) second |= (m[8]![size - 1 - i] ? 1 : 0) << i;
  for (let i = 8; i < 15; i++) second |= (m[size - 15 + i]![8] ? 1 : 0) << i;
  const mask = Array.from({ length: 8 }, (_, k) => formatBits(k)).indexOf(first);

  const fixed = fixedOf(size);
  const bits = dataModuleOrder(fixed).map(([x, y]) => m[y]![x]! !== MASKS[mask]!(x, y));
  const [ecPerBlock, blocks, total] = BLOCKS[version]!;
  const words: number[] = [];
  for (let i = 0; i + 8 <= total * 8; i += 8) words.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | (b ? 1 : 0), 0));
  const perBlock = (total - ecPerBlock * blocks) / blocks;
  const data = Array.from({ length: blocks }, () => [] as number[]);
  const ecc = Array.from({ length: blocks }, () => [] as number[]);
  let at = 0;
  for (let i = 0; i < perBlock; i++) for (let b = 0; b < blocks; b++) data[b]!.push(words[at++]!);
  for (let i = 0; i < ecPerBlock; i++) for (let b = 0; b < blocks; b++) ecc[b]!.push(words[at++]!);
  const eccOk = data.every((block, b) => rsRemainder(block, ecPerBlock).every((w, i) => w === ecc[b]![i]));

  const stream = data.flat().flatMap((w) => Array.from({ length: 8 }, (_, i) => (w >> (7 - i)) & 1));
  const take = (from: number, n: number) => stream.slice(from, from + n).reduce((acc, b) => (acc << 1) | b, 0);
  expect(take(0, 4)).toBe(0b0100);
  const length = take(4, 8);
  const bytes = Array.from({ length }, (_, i) => take(12 + 8 * i, 8));
  return { text: new TextDecoder().decode(new Uint8Array(bytes)), mask, eccOk, formatCopiesAgree: first === second };
}

describe('qrModules — the pairing link as a QR code', () => {
  it('draws the pairing link exactly as the independent decoder read it', () => {
    expect(drawn(qrModules(PAIRING_LINK)!)).toEqual(GOLDEN);
  });

  it('reads back to the text it was given, with its error correction whole and its format said twice alike', () => {
    for (const text of [PAIRING_LINK, 'http://localhost:5173/?pair=123456', 'A', 'café ✓ 😀', 'x'.repeat(QR_MAX_BYTES)]) {
      const read = readBack(qrModules(text)!);
      expect(read.text, text).toBe(text);
      expect(read.eccOk, text).toBe(true);
      expect(read.formatCopiesAgree, text).toBe(true);
      expect(read.mask, text).toBeGreaterThanOrEqual(0);
    }
  });

  it('takes the smallest version the text fits, up to version 6', () => {
    const sizeFor = (bytes: number) => qrModules('x'.repeat(bytes))!.length;
    expect([14, 15, 26, 27, 42, 43, 62, 63, 84, 85, 106].map(sizeFor)).toEqual([21, 25, 25, 29, 29, 33, 33, 37, 37, 41, 41]);
    expect(QR_MAX_BYTES).toBe(106);
  });

  it('gives no code for text longer than version 6 carries: the screen shows the address alone', () => {
    expect(qrModules('x'.repeat(QR_MAX_BYTES + 1))).toBeUndefined();
  });

  it('has its three finder patterns in their corners', () => {
    const m = qrModules(PAIRING_LINK)!;
    const size = m.length;
    const finder = ['#######', '#.....#', '#.###.#', '#.###.#', '#.###.#', '#.....#', '#######'];
    for (const [x0, y0] of [[0, 0], [size - 7, 0], [0, size - 7]] as const) {
      expect(m.slice(y0, y0 + 7).map((row) => row.slice(x0, x0 + 7).map((d) => (d ? '#' : '.')).join(''))).toEqual(finder);
    }
  });
});

describe('qrRuns — a row as blocks to draw', () => {
  it('joins each row\'s neighbouring dark modules into one run', () => {
    expect(qrRuns([[true, true, false, true], [false, false, false, false], [true, false, true, true]])).toEqual([[[0, 2], [3, 1]], [], [[0, 1], [2, 2]]]);
  });
});
