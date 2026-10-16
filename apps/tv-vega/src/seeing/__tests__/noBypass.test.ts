/**
 * Easier to see applies everywhere because every screen asks the theme it
 * is drawn in (packages/vega-calm-ui CalmPreferences.tsx) — and only
 * because of that. One screen that takes a colour or a size straight from
 * the tokens would stay small, or stay grey on grey, whatever she chose,
 * and nothing else would notice. This reads the source, as
 * words/__tests__/hardcoded.test.ts does, and fails on such a screen.
 *
 * What it looks for, in every runtime file of the app:
 *   1. a colour or a size imported from vega-calm-ui as it stands — the
 *      palette, the type scale, `fontSize`, `actionColours` — instead of
 *      asked of the theme;
 *   2. a style sheet made once, at the top of a file, that sets a colour,
 *      a size or a line height: those are made per theme, by a function of
 *      the theme (`useCalmStyles(makeStyles)`);
 *   3. a colour written out, but for the black behind a film, which is the
 *      same in both palettes.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runtimeFiles(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : runtimeFiles(path);
    return /\.tsx?$/.test(entry) && !entry.endsWith('.d.ts') ? [path] : [];
  });
}

/** What may not be imported from vega-calm-ui by anything that draws. */
const STATIC = new Set(['safe', 'palette', 'highContrastPalette', 'type', 'fontSize', 'actionColours']);

const files = runtimeFiles().map((path) => ({ path, name: relative(SRC, path), source: readFileSync(path, 'utf8') }));

function importedFromCalmUi(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'@wick\/vega-calm-ui'/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** Each `StyleSheet.create({...})` at the top level of a file: one that is not inside a function of the theme. */
function staticSheets(source: string): string[] {
  const sheets: string[] = [];
  for (const m of source.matchAll(/^const \w+ = StyleSheet\.create\(\{([\s\S]*?)^\}\);/gm)) sheets.push(m[1]!);
  return sheets;
}

describe('no screen bypasses the theme', () => {
  it('finds the app’s screens to read', () => {
    expect(files.some((f) => f.name === 'home/HomeScreen.tsx')).toBe(true);
    expect(files.length).toBeGreaterThan(50);
  });

  it('imports no colour or size from vega-calm-ui as it stands', () => {
    const offending = files.flatMap((f) => importedFromCalmUi(f.source).filter((n) => STATIC.has(n)).map((n) => `${f.name}: ${n}`));
    expect(offending).toEqual([]);
  });

  it('makes no style sheet with a colour or a size once for all themes', () => {
    const offending = files.flatMap((f) =>
      staticSheets(f.source)
        .filter((sheet) => /\b(color|backgroundColor|borderColor|fontSize|lineHeight)\s*:/.test(sheet))
        .map(() => f.name),
    );
    expect(offending).toEqual([]);
  });

  it('writes out no colour but the black behind a film', () => {
    const offending = files.flatMap((f) => [...f.source.matchAll(/'#[0-9A-Fa-f]{3,8}'/g)].map((m) => m[0]).filter((c) => c !== "'#000000'").map((c) => `${f.name}: ${c}`));
    expect(offending).toEqual([]);
  });

  it('puts the one provider at the root, around every screen', () => {
    const app = files.find((f) => f.name === 'App.tsx')!.source;
    expect(app).toMatch(/<SeeingProvider>\s*<Television \/>\s*<\/SeeingProvider>/);
    const provider = files.find((f) => f.name === 'seeing/SeeingProvider.tsx')!.source;
    expect(provider).toMatch(/<CalmPreferencesProvider preferences=\{preferences\}>/);
  });

  // The rule above must catch what it is for.
  it('catches a sheet made once with a colour in it', () => {
    expect(staticSheets("const styles = StyleSheet.create({\n  a: { color: t },\n});\n")).toHaveLength(1);
    expect(importedFromCalmUi("import { CalmCard, fontSize } from '@wick/vega-calm-ui';")).toContain('fontSize');
  });
});
