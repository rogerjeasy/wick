/**
 * A family member's own television runs nothing that is the resident's.
 *
 * That is true by construction — App.tsx mounts ResidentApp.tsx or
 * family/FamilyApp.tsx, never both, and everything of the resident's lives
 * in the first — and this holds the construction in place. It reads the
 * source the way apps/tv-fireos's parity test does: an import added to the
 * family screen, or to App.tsx itself, that could open the card channel,
 * send a DeviceEvent, run the Natural-Break Engine, report where a film has
 * got to or write to Content Personalization fails here, not on a
 * television.
 *
 * Two things a family television does share with the resident's, and only
 * these: the player that shows a film (the seat follows hers with it, and
 * tells nobody), and the one line that starts the background service —
 * which, for a family television, holds no card channel either
 * (headless/waitingService.ts, held to the same rule below).
 *
 * And one thing it says to the platform, which is no: while the seat is
 * open every media command ("Alexa, pause") is refused (media/noFilm.ts).
 * That is the one Vega service a family television names, and it reaches
 * nothing of the resident's watch screen to do it.
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
const RESIDENTS = /^(ResidentApp\.tsx|transport\/|headless\/(?!launchCardService\.ts$)|break\/|personalization\/|watch\/|player\/|catalog\/|cards\/|home\/|live\/|notify\/)/;

/** Everything by which the resident's television sends, reports or decides. None of it is named in a family television's code. */
const RESIDENTS_NAMES =
  /holdCardChannel|createDeviceChannel|enqueueOutbound|QueueStore|BreakController|NaturalBreakEngine|PlaybackEventStore|DeviceEvent|WebSocket|mqtt|PlayerService|PlaybackRecorder|playbackRecorder|TogetherReporter|togetherReporter|toPlaybackDeviceEvent|toStoredPlaybackEvent|watchCommand|seekTarget/;

/** A file's code, without its comments: what it does, not what it says it does not do. */
const code = (file: string): string =>
  readFileSync(join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    // A type is erased when the app is built: naming one brings nothing with it.
    .replace(/^\s*import type [^;]*;$/gm, '');

describe("a family member's own television, kept apart from the resident's", () => {
  const family = reach(join(SRC, 'family/FamilyApp.tsx'));

  it('is made of the family screens, the on-screen check, the line that starts the background service, and nothing else of this app', () => {
    expect(family.files).toEqual([
      'family/FamilyApp.tsx',
      'family/FamilyHome.tsx',
      'family/FamilyReader.tsx',
      'family/FamilySeat.tsx',
      'family/familyClient.ts',
      'family/familyScreen.ts',
      'family/layout.ts',
      'family/looker.ts',
      'family/mode.ts',
      'family/offScreen.ts',
      'family/presses.ts',
      'family/reader.ts',
      'family/repeat.ts',
      'family/seat.ts',
      'headless/launchCardService.ts',
      'media/noFilm.ts',
      'media/refusal.ts',
      'press/settle.ts',
      'useOnScreen.ts',
    ]);
  });

  it("reaches nothing that is the resident's: no card channel, no card service, no break engine, no programme, no Content Personalization", () => {
    expect(family.files.filter((file) => RESIDENTS.test(file))).toEqual([]);
  });

  it('uses no transport of its own and no Vega service but the one that refuses: only the screen, the shared film player, and fetch', () => {
    expect(family.packages).toEqual([
      '@amazon-devices/kepler-media-controls',
      '@amazon-devices/react-native-kepler',
      '@amazon-devices/react-native-w3cmedia',
      '@wick/contracts',
      '@wick/vega-calm-ui',
      'react',
      'react-native',
    ]);
  });

  it('never names the things only the resident\'s television does', () => {
    expect(family.files.filter((file) => RESIDENTS_NAMES.test(code(file)))).toEqual([]);
  });

  it('starts the background service from one place, and brings in nothing with it', () => {
    expect(family.files.filter((file) => /launchCardService/.test(code(file)))).toEqual(['family/FamilyApp.tsx', 'headless/launchCardService.ts']);
    expect(imports(join(SRC, 'headless/launchCardService.ts'))).toEqual([]);
  });
});

describe('the seat beside her film — a player that follows, and tells nobody', () => {
  it('takes the film player from the shared package and nothing from the resident\'s watch screen', () => {
    expect(direct('family/FamilySeat.tsx')).toEqual([
      '@amazon-devices/react-native-kepler',
      '@amazon-devices/react-native-w3cmedia',
      '@wick/contracts',
      '@wick/vega-calm-ui',
      'family/familyScreen.ts',
      'family/presses.ts',
      'family/repeat.ts',
      'family/seat.ts',
      'media/noFilm.ts',
      'react',
    ]);
  });

  it('listens for no key of the remote: there is no pause, no seek and no skip to be had here — only Back', () => {
    const seat = code('family/FamilySeat.tsx');

    expect(seat).not.toMatch(/useTVEventHandler/);
    expect(seat).toMatch(/hardwareBackPress/);
    expect(seat).not.toMatch(/onPress=/);
  });

  it('sets its player\'s place and whether it runs from the follow rule alone', () => {
    const seat = code('family/FamilySeat.tsx');

    expect(seat.match(/\.currentTime\s*=(?!=)/g)).toHaveLength(1);
    expect(seat).toMatch(/p\.currentTime = step\.seekToMs \/ 1000/);
    expect(seat.match(/\.play\(\)/g)).toHaveLength(1);
    expect(seat.match(/\.pause\(\)/g)).toHaveLength(1);
  });
});

describe("a family television's background service, kept apart as well", () => {
  const service = reach(join(SRC, 'headless/waitingService.ts'));

  it('is made of the asking, the toast and the pairing flow — and no card channel', () => {
    expect(service.files).toEqual([
      'family/repeat.ts',
      'headless/waitingService.ts',
      'notify/doorToast.ts',
      'notify/waitingToast.ts',
      'pairing/PairingFlow.ts',
    ]);
  });

  it('never names the things only the resident\'s television does', () => {
    expect(service.files.filter((file) => RESIDENTS_NAMES.test(code(file)))).toEqual([]);
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
      'pairing/connect.ts',
      'react',
      'seeing/SeeingProvider.tsx',
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
