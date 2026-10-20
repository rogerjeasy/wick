/**
 * The guard behind `npm run check:no-mocks` (scripts/check-no-mocks.mjs):
 * every way a file can name a module is caught, comments and strings are
 * not, and the television's runtime code is clean today.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findMockImports, mockImports } from '../check-no-mocks.mjs';

describe('mockImports', () => {
  it.each([
    ['a named import', "import { ContentPersonalizationMocks } from './mocks/cp';"],
    ['a default import', "import Mock from '../MockPlayer';"],
    ['a namespace import', "import * as m from './mock';"],
    ['a type-only import', "import type { Fake } from './mocks/types';"],
    ['an import across lines', "import {\n  a,\n  b,\n} from\n  './mocks/data';"],
    ['a re-export', "export { thing } from './mocks/thing';"],
    ['a star re-export', "export * from './mockData';"],
    ['a bare import', "import './mocks/setup';"],
    ['a dynamic import', "const m = await import('./mocks/later');"],
    ['a require', "const m = require('./mocks/old');"],
  ])('catches %s', (_, source) => {
    expect(mockImports(source)).toHaveLength(1);
  });

  it('ignores the word in comments and strings', () => {
    const source = [
      "// import { X } from './mocks/x';",
      "/* export * from './mocks/y'; */",
      "const note = \"import { Z } from './mocks/z'\";",
      "import { real } from './real';",
    ].join('\n');
    expect(mockImports(source)).toEqual([]);
  });

  it('passes a module whose name does not say mock', () => {
    expect(mockImports("import { QueueStore } from './headless/QueueStore.js';")).toEqual([]);
  });
});

describe('findMockImports', () => {
  it('finds a mock imported by runtime code, and leaves __tests__ alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'no-mocks-'));
    mkdirSync(join(root, 'src/__tests__'), { recursive: true });
    writeFileSync(join(root, 'src/App.tsx'), "import { Fake } from './mocks/fake';\n");
    writeFileSync(join(root, 'src/__tests__/App.test.ts'), "import { Fake } from '../mocks/fake';\n");
    expect(findMockImports(['src'], root)).toEqual(['src/App.tsx -> ./mocks/fake']);
  });

  it('finds nothing in the television runtime code', () => {
    expect(findMockImports()).toEqual([]);
  });
});
