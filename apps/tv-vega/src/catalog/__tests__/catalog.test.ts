import { describe, expect, it } from 'vitest';
import { CATALOG, PROGRAMMES_ORIGIN, programmeById } from '../catalog.js';

describe('CATALOG', () => {
  it('offers at most three programmes — three, never four', () => {
    expect(CATALOG.length).toBeGreaterThan(0);
    expect(CATALOG.length).toBeLessThanOrEqual(3);
  });

  it('gives every programme a unique id', () => {
    expect(new Set(CATALOG.map((p) => p.id)).size).toBe(CATALOG.length);
  });

  it('offers all three of the open films', () => {
    expect(CATALOG.map((p) => p.id)).toEqual(['big-buck-bunny', 'sintel', 'tears-of-steel']);
  });

  it("plays every programme from Wick's own origin — no third-party demo host", () => {
    for (const p of CATALOG) expect(p.streamUrl).toBe(`${PROGRAMMES_ORIGIN}/${p.id}/index.m3u8`);
  });

  it('plays only over HTTPS — the player drops cleartext HLS silently (FL-016)', () => {
    for (const p of CATALOG) expect(p.streamUrl).toMatch(/^https:\/\//);
  });

  it('marks where the credits start, inside the programme', () => {
    for (const p of CATALOG) {
      expect(p.creditsPositionMs).toBeGreaterThan(0);
      expect(p.creditsPositionMs).toBeLessThan(p.durationMs);
    }
  });

  it('carries the attribution its licence requires', () => {
    for (const p of CATALOG) {
      expect(p.attribution).toMatch(/Blender Foundation/);
      expect(p.licence).toBe('CC BY 3.0');
    }
  });
});

describe('programmeById', () => {
  it('finds a programme by its id', () => {
    expect(programmeById(CATALOG[0]!.id)).toBe(CATALOG[0]);
  });

  it('returns undefined for an unknown id', () => {
    expect(programmeById('nope')).toBeUndefined();
  });
});
