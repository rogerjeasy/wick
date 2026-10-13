/**
 * A family member's own television runs nothing that is the resident's.
 *
 * That is true by construction — App.tsx mounts ResidentApp.tsx or
 * family/FamilyApp.tsx, never both, and everything of the resident's lives
 * in the first — and this holds the construction in place. It reads the
 * source the way apps/tv-fireos's parity test does: an import added to the
 * family screen, or to App.tsx itself, that could open the card channel,
 * start the card service, send a DeviceEvent, run the Natural-Break Engine
 * or write to Content Personalization fails here, not on a television.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** What a file really imports: `import type` is erased when the app is built, and brings no code with it. */
function imports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const m of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+'([^']+)'/gm)) found.push(m[1]!);
  for (const m of source.matchAll(/^\s*import\s+'([^']+)'/gm)) found.push(m[1]!);
  for (const m of source.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)) found.push(m[1]!);
  for (const m of source.matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)) found.push(m[1]!);
  return found;
}

/** A relative import, as the file it names; undefined for a package. */
function sourceFile(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(from), specifier.replace(/\.js$/, ''));
  const file = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((candidate) => existsSync(candidate));
  if (!file) throw new Error(`${relative(SRC, from)} imports ${specifier}, which is not a file`);
  return file;
}

/** Every source file reachable from one, and every package named on the way. */
function reach(entry: string): { readonly files: string[]; readonly packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const walk = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const specifier of imports(file)) {
      const next = sourceFile(file, specifier);
      if (next) walk(next);
      else packages.add(specifier);
    }
  };
  walk(entry);
  return { files: [...files].map((f) => relative(SRC, f)).sort(), packages: [...packages].sort() };
}

const direct = (file: string): string[] =>
  imports(join(SRC, file))
    .map((specifier) => {
      const next = sourceFile(join(SRC, file), specifier);
      return next ? relative(SRC, next) : specifier;
    })
    .sort();

/**
 * The resident's: the card channel and what feeds it, the card service and
 * the other background components, the break engine, what she watches and
 * the record of it, her cards, her home screen, the door camera.
 */
const RESIDENTS = /^(ResidentApp\.tsx|transport\/|headless\/|break\/|personalization\/|watch\/|player\/|catalog\/|cards\/|home\/|live\/|notify\/)/;

describe("a family member's own television, kept apart from the resident's", () => {
  const family = reach(join(SRC, 'family/FamilyApp.tsx'));

  it('is made of the family screen, the on-screen check, and nothing else of this app', () => {
    expect(family.files).toEqual([
      'family/FamilyApp.tsx',
      'family/FamilyHome.tsx',
      'family/familyClient.ts',
      'family/familyScreen.ts',
      'family/looker.ts',
      'family/mode.ts',
      'useOnScreen.ts',
    ]);
  });

  it("reaches nothing that is the resident's: no card channel, no card service, no break engine, no programme, no Content Personalization", () => {
    expect(family.files.filter((file) => RESIDENTS.test(file))).toEqual([]);
  });

  it('uses no transport of its own and no Vega service: only the screen, and fetch', () => {
    expect(family.packages).toEqual(['@amazon-devices/react-native-kepler', '@wick/contracts', '@wick/vega-calm-ui', 'react', 'react-native']);
  });

  it('never names the things only the resident\'s television does', () => {
    const forbidden = /holdCardChannel|createDeviceChannel|launchCardService|enqueueOutbound|QueueStore|BreakController|NaturalBreakEngine|PlaybackEventStore|DeviceEvent|WebSocket|mqtt/;
    const named = family.files.filter((file) => {
      const code = readFileSync(join(SRC, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      return forbidden.test(code);
    });

    expect(named).toEqual([]);
  });
});

describe('App.tsx — the one branch', () => {
  it("imports the pairing flow, the two apps and the decision between them — and nothing of the resident's itself", () => {
    expect(direct('App.tsx')).toEqual([
      '@amazon-devices/kepler-file-system',
      '@amazon-devices/react-native-kepler',
      'ResidentApp.tsx',
      'config.ts',
      'deviceId.ts',
      'family/FamilyApp.tsx',
      'family/mode.ts',
      'pairing/PairingFlow.ts',
      'pairing/PairingScreen.tsx',
      'react',
    ]);
  });

  it("mounts the resident's app in one place only, and only for a television that is not a family member's", () => {
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');

    expect(app.match(/<ResidentApp\b/g)).toHaveLength(1);
    expect(app.match(/<FamilyApp\b/g)).toHaveLength(1);
    // The family branch returns before the resident's app is reached.
    const branch = app.indexOf("televisionMode(screen.token) === 'family'");
    expect(branch).toBeGreaterThan(-1);
    expect(app.indexOf('<FamilyApp')).toBeGreaterThan(branch);
    expect(app.indexOf('<ResidentApp')).toBeGreaterThan(app.indexOf('<FamilyApp'));
  });

  it("keeps everything the resident's television does inside ResidentApp", () => {
    const residents = direct('ResidentApp.tsx');

    for (const needed of ['transport/startCardChannel.ts', 'transport/createDeviceChannel.ts', 'headless/launchCardService.ts', 'headless/QueueStore.ts', 'break/BreakController.ts', 'personalization/PlaybackEventStore.ts']) {
      expect(residents).toContain(needed);
    }
  });
});
