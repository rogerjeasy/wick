/**
 * The browser television's two generated files (scripts/tv-page/build.ts),
 * held to their sources: what she can watch and where its calm points are,
 * and the television's own rules bundled from the Vega app. Neither is ever
 * edited by hand — calm points are measured, never guessed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CATALOG_FILE, CHANNELS_FILE, ENGINE_FILE, catalog, renderCatalog, renderChannels, renderEngine } from '../../../scripts/tv-page/build.js';
import { PROGRAMMES } from '../../../packages/contracts/src/programmes.js';
import { CALM_POINTS } from '../../tv-vega/src/catalog/calmPoints.js';
import { PRESS_SETTLE_MS } from '../../tv-vega/src/press/settle.js';
import { HOLD_MS } from '../../tv-vega/src/watch/hold.js';
import { WORDS } from '../../tv-vega/src/words/words.js';
import { ICONS, vendorFiles, vendoredNow } from '../../../scripts/web-vendor.mjs';

describe('tv-catalog.json — what she can watch, and where a note may arrive inside it', () => {
  it('is exactly what `npm run tv:build` writes now', () => {
    expect(readFileSync(CATALOG_FILE, 'utf8')).toBe(renderCatalog());
  });

  it('has the three films of the television’s catalogue, in its order, three and never four', () => {
    const { programmes } = JSON.parse(readFileSync(CATALOG_FILE, 'utf8')) as ReturnType<typeof catalog>;

    expect(programmes.map((p) => p.id)).toEqual(PROGRAMMES.map((p) => p.id));
    expect(programmes.length).toBeLessThanOrEqual(3);
    for (const p of programmes) {
      const source = PROGRAMMES.find((q) => q.id === p.id)!;
      expect(p).toMatchObject({ title: source.title, line: source.line, durationMs: source.durationMs, creditsPositionMs: source.creditsPositionMs, attribution: source.attribution });
    }
  });

  it('gives each film the calm points that were measured for it, and none that were not', () => {
    const { programmes } = JSON.parse(readFileSync(CATALOG_FILE, 'utf8')) as ReturnType<typeof catalog>;

    for (const p of programmes) {
      expect(p.calmPointsMs).toEqual((CALM_POINTS[p.id] ?? []).map((point) => point.atMs));
      // Inside the story: before the credits, where a note would cost the story nothing anyway.
      for (const at of p.calmPointsMs) expect(at).toBeLessThan(p.creditsPositionMs);
    }
  });
});

describe('tv-engine.generated.js — the television’s own rules, bundled from the Vega app', () => {
  it('is exactly what `npm run tv:build` writes now', async () => {
    expect(readFileSync(ENGINE_FILE, 'utf8')).toBe(await renderEngine());
  });

  it('sets one global, WickTv, and nothing else a page could trip over', () => {
    const context = vm.createContext({});
    vm.runInContext(readFileSync(ENGINE_FILE, 'utf8'), context);
    const tv = vm.runInContext('WickTv', context) as Record<string, unknown>;

    expect(Object.keys(context)).toEqual(['WickTv']);
    expect(tv.PRESS_SETTLE_MS).toBe(PRESS_SETTLE_MS);
    expect(tv.HOLD_MS).toBe(HOLD_MS);
    expect(typeof tv.BreakController).toBe('function');
    expect((tv.words as (l: string) => (k: string) => string)('es')('home.question')).toBe(WORDS.es['home.question']);
  });
});

describe('tv-channels.generated.js — how the page reaches home, bundled from the Vega app', () => {
  it('is exactly what `npm run tv:build` writes now', async () => {
    expect(readFileSync(CHANNELS_FILE, 'utf8')).toBe(await renderChannels());
  });

  it('runs in a bare browser page and sets one global, WickTvChannels, which opens a channel', () => {
    // A page has no `process`, no `require` and no `Buffer`: the bundle must not ask for them when it loads.
    const context = vm.createContext({
      setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, URL, URLSearchParams, console, AbortController, AbortSignal, TextEncoder, TextDecoder, Event, EventTarget, atob, btoa,
      crypto: globalThis.crypto, WebSocket: class {}, navigator: { userAgent: 'a browser', product: 'Gecko' },
    });
    // A page is its own `self`, which the library reads its AbortController from.
    context.self = context;
    vm.runInContext(readFileSync(CHANNELS_FILE, 'utf8'), context);
    const channels = vm.runInContext('WickTvChannels', context) as Record<string, unknown>;

    expect(Object.keys(channels)).toEqual(['createDeviceChannel']);
    expect(Object.keys(context)).toContain('WickTvChannels');
    expect(typeof channels.createDeviceChannel).toBe('function');
  });
});

describe('vendor/ — the web’s libraries, served from the page’s own origin (scripts/web-vendor.mjs)', () => {
  const tf = readFileSync(new URL('../../../infra/ops-console.tf', import.meta.url), 'utf8');

  it('is exactly what `npm run web:vendor` writes now: no file more, none less, not a byte different', async () => {
    const written = await vendorFiles();
    const now = vendoredNow();
    expect([...now.keys()].sort()).toEqual([...written.keys()].sort());
    for (const [file, content] of written) expect(now.get(file)!.equals(Buffer.from(content)), file).toBe(true);
  });

  it('is deployed file by file, each with its own type, under a policy that lets the page load its own fonts', async () => {
    for (const file of (await vendorFiles()).keys()) expect(tf, file).toMatch(new RegExp(`"${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s+= "[a-z]+/[a-z0-9.+-]+(; charset=utf-8)?"`));
    expect(tf).toContain('key           = "vendor/${each.key}"');
    expect(readFileSync(new URL('../../../infra/csp/ops-console.csp', import.meta.url), 'utf8')).toMatch(/^font-src 'self';$/m);
  });

  it('gives the page the typeface from its own files, and the font’s licence beside them', () => {
    const css = readFileSync(new URL('../vendor/fonts.css', import.meta.url), 'utf8');
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]!);
    expect(urls.length).toBe(2);
    for (const url of urls) {
      expect(url).toMatch(/^fonts\/[a-z-]+\.woff2$/);
      readFileSync(new URL(`../vendor/${url}`, import.meta.url));
    }
    expect(css).toContain("font-family: 'Atkinson Hyperlegible Next Variable'");
    expect(readFileSync(new URL('../vendor/fonts/OFL.txt', import.meta.url), 'utf8')).toContain('SIL Open Font License');
  });

  it('builds every icon the page names as an <svg> with createElementNS, and sets one global, WickIcons', () => {
    const made: Array<{ ns: string; tag: string; attrs: Record<string, string>; children: unknown[] }> = [];
    const document = {
      createElementNS: (ns: string, tag: string) => {
        const node = { ns, tag, attrs: {} as Record<string, string>, children: [] as unknown[], setAttribute(k: string, v: string) { this.attrs[k] = v; }, appendChild(c: unknown) { this.children.push(c); return c; } };
        made.push(node);
        return node;
      },
    };
    const context = vm.createContext({ document });
    vm.runInContext(readFileSync(new URL('../vendor/icons.generated.js', import.meta.url), 'utf8'), context);
    expect(Object.keys(context)).toEqual(['document', 'WickIcons']);
    const icons = vm.runInContext('WickIcons', context) as { icon(name: string): { tag: string; attrs: Record<string, string>; children: unknown[] } | null; names: string[] };
    expect(icons.names).toEqual(Object.keys(ICONS));
    for (const name of icons.names) {
      const svg = icons.icon(name)!;
      expect(svg.tag).toBe('svg');
      expect(svg.attrs).toMatchObject({ 'aria-hidden': 'true', stroke: 'currentColor', viewBox: '0 0 24 24' });
      expect(svg.children.length).toBeGreaterThan(0);
    }
    expect(made.every((node) => node.ns === 'http://www.w3.org/2000/svg')).toBe(true);
    expect(icons.icon('no-such-icon')).toBe(null);
    expect(readFileSync(new URL('../vendor/icons.generated.js', import.meta.url), 'utf8')).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\(/);
  });

  it('gives Motion’s animate as one global, WickMotion, that loads in a bare page', () => {
    const context = vm.createContext({ window: {}, document: {}, performance, requestAnimationFrame: () => 0 });
    vm.runInContext(readFileSync(new URL('../vendor/motion.generated.js', import.meta.url), 'utf8'), context);
    expect(Object.keys(context)).toContain('WickMotion');
    expect(typeof (vm.runInContext('WickMotion', context) as { animate: unknown }).animate).toBe('function');
  });

  it('serves the tour’s door picture as the stand-in doorbell’s own made picture, byte for byte', () => {
    expect(readFileSync(new URL('../parcel.jpg', import.meta.url)).equals(readFileSync(new URL('../../../docs/demo-door/parcel.jpg', import.meta.url)))).toBe(true);
    expect(tf).toContain('key           = "parcel.jpg"');
  });
});
