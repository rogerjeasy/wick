import { describe, expect, it } from 'vitest';
import { CATALOG, PROGRAMMES_ORIGIN, calmPointsOf, programmeById } from '../catalog.js';
import { DETECTED_END_CREDITS_MS } from '../calmPoints.js';

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

describe('calm points — where a note may arrive inside a programme', () => {
  it('are known for every programme in the catalogue, in order', () => {
    for (const programme of CATALOG) {
      const points = calmPointsOf(programme.id);

      expect(points, programme.id).toBeDefined();
      expect([...points!].sort((a, b) => a - b)).toEqual(points);
    }
  });

  it('are never in the first minute, never in the last minute before the credits, and never close together', () => {
    for (const programme of CATALOG) {
      const points = calmPointsOf(programme.id)!;

      for (const at of points) {
        expect(at, programme.id).toBeGreaterThanOrEqual(60_000);
        expect(at, programme.id).toBeLessThanOrEqual(programme.creditsPositionMs - 55_000);
      }
      for (let i = 1; i < points.length; i += 1) expect(points[i]! - points[i - 1]!, programme.id).toBeGreaterThanOrEqual(90_000);
    }
  });

  it('exist: at least one programme has somewhere a note can arrive before its credits', () => {
    expect(CATALOG.some((programme) => calmPointsOf(programme.id)!.length > 0)).toBe(true);
  });

  it('are nothing for a programme Wick has not measured', () => {
    expect(calmPointsOf('something-else')).toBeUndefined();
  });

  it('agree with the credits measured by hand: Rekognition found each film’s end credits within five seconds of the frame-by-frame value', () => {
    for (const programme of CATALOG) {
      expect(Math.abs(DETECTED_END_CREDITS_MS[programme.id]! - programme.creditsPositionMs), programme.id).toBeLessThanOrEqual(5_000);
    }
  });
});
