/**
 * The browser television's two generated files (scripts/tv-page/build.ts),
 * held to their sources: what she can watch and where its calm points are,
 * and the television's own rules bundled from the Vega app. Neither is ever
 * edited by hand — calm points are measured, never guessed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CATALOG_FILE, ENGINE_FILE, catalog, renderCatalog, renderEngine } from '../../../scripts/tv-page/build.js';
import { PROGRAMMES } from '../../../packages/contracts/src/programmes.js';
import { CALM_POINTS } from '../../tv-vega/src/catalog/calmPoints.js';
import { PRESS_SETTLE_MS } from '../../tv-vega/src/press/settle.js';
import { HOLD_MS } from '../../tv-vega/src/watch/hold.js';
import { WORDS } from '../../tv-vega/src/words/words.js';

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
