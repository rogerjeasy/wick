/**
 * The Fire OS app loads the Vega app's source and swaps what
 * adapters.config.js lists. A swap only works if the stand-in offers every
 * name the shared source asks the original for — and nothing checks that
 * when the Vega app is built, because the Vega build never sees a stand-in.
 * This does: a new import in apps/tv-vega/src that Fire OS cannot satisfy
 * fails here, not on a television.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface AdapterTable {
  readonly repoRoot: string;
  readonly vegaApp: string;
  readonly MODULES: Readonly<Record<string, string>>;
  readonly FILES: Readonly<Record<string, string>>;
  readonly UNAVAILABLE: string;
}
const table = createRequire(import.meta.url)('../../adapters.config.js') as AdapterTable;

/** Every source file the Fire OS bundle can draw on: the Vega app's and the shared packages'. */
function sharedSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== '__tests__' && entry !== 'node_modules' && entry !== 'dist') walk(path);
      } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
        files.push(path);
      }
    }
  };
  walk(join(table.vegaApp, 'src'));
  walk(join(table.repoRoot, 'packages/vega-calm-ui/src'));
  return files;
}

const names = (list: string): string[] =>
  list
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((part) => part.split(/\s+as\s+/)[0]!.trim());

/** The names a source file takes from a module, whether imported at the top or in a lazy `import()`. */
function importedFrom(source: string, moduleName: string): string[] {
  const quoted = moduleName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const found: string[] = [];
  for (const m of source.matchAll(new RegExp(`import\\s+(?:type\\s+)?\\{([^}]+)\\}\\s+from\\s+'${quoted}'`, 'g'))) found.push(...names(m[1]!));
  for (const m of source.matchAll(new RegExp(`\\{([^}]+)\\}\\s*=\\s*await\\s+import\\('${quoted}'\\)`, 'g'))) found.push(...names(m[1]!));
  return found;
}

/** The names a file exports. */
function exportedBy(file: string): Set<string> {
  const source = readFileSync(file, 'utf8');
  const found = new Set<string>();
  for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|type|interface)\s+(\w+)/g)) found.add(m[1]!);
  for (const m of source.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim();
      if (name) found.add(name);
    }
  }
  return found;
}

const sources = sharedSources().map((file) => ({ file, text: readFileSync(file, 'utf8') }));

describe('what Fire OS swaps for the Vega app', () => {
  const amazon = Object.keys(table.MODULES).filter((name) => name.startsWith('@amazon-devices/'));

  it('stands in for the three Amazon packages the on-screen app uses', () => {
    expect(amazon.sort()).toEqual([
      '@amazon-devices/kepler-file-system',
      '@amazon-devices/react-native-kepler',
      '@amazon-devices/react-native-w3cmedia',
    ]);
  });

  for (const moduleName of amazon) {
    it(`offers every name the shared source takes from ${moduleName}`, () => {
      const wanted = new Set(sources.flatMap((s) => importedFrom(s.text, moduleName)));
      const offered = exportedBy(table.MODULES[moduleName]!);

      expect(wanted.size).toBeGreaterThan(0);
      expect([...wanted].filter((name) => !offered.has(name))).toEqual([]);
    });
  }

  it('replaces a file only with one that exports the same names', () => {
    const replaced = Object.entries(table.FILES);

    expect(replaced.length).toBeGreaterThan(0);
    for (const [original, override] of replaced) {
      const offered = exportedBy(override);
      expect([...exportedBy(original)].filter((name) => !offered.has(name)), original).toEqual([]);
    }
  });

  it('offers nothing in the stand-in for the packages Fire OS does not have', () => {
    expect([...exportedBy(table.UNAVAILABLE)]).toEqual([]);
  });

  it('keeps Amazon packages it has no stand-in for out of what is on screen', () => {
    // The files a Vega background process runs, and the two that speak to
    // Vega-only platform services. Nothing the Fire OS app renders imports them.
    const vegaOnly = /src\/(headless\/(CardService|DataRefreshService|RhythmSyncTask|HeadlessInterface)|personalization\/handlers|notify\/doorToast)\.ts$/;
    const strays = sources
      .filter((s) => !vegaOnly.test(s.file))
      .flatMap((s) => [...s.text.matchAll(/^import\s+(?!type\b)[^'"]*from\s+'(@amazon-devices\/[^']+)'/gm)].map((m) => `${s.file.replace(table.repoRoot + '/', '')}: ${m[1]}`))
      .filter((line) => !amazon.some((name) => line.endsWith(`: ${name}`)));

    expect(strays).toEqual([]);
  });
});
