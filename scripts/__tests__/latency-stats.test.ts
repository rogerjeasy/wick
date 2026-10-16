import { describe, expect, it } from 'vitest';
import { parseServerTiming, percentile, phaseSamples, row, summarise } from '../latency/stats.js';

describe('percentile (nearest rank)', () => {
  it('reads the sorted samples, whatever order they came in', () => {
    const samples = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    expect(percentile(samples, 50)).toBe(5);
    expect(percentile(samples, 95)).toBe(10);
    expect(percentile(samples, 99)).toBe(10);
    expect(percentile(samples, 0)).toBe(1);
  });

  it('says nothing about no samples', () => {
    expect(percentile([], 50)).toBeUndefined();
    expect(summarise([])).toBeUndefined();
  });

  it('puts p95 of a hundred calls on the 95th slowest, so five slow calls in a hundred show', () => {
    const samples = [...Array.from({ length: 95 }, () => 200), 900, 950, 1000, 1050, 1100];
    expect(percentile(samples, 95)).toBe(200);
    expect(percentile(samples, 96)).toBe(900);
    expect(summarise(samples)).toMatchObject({ n: 100, p50: 200, p99: 1050, max: 1100, over: 5 });
  });
});

describe('parseServerTiming', () => {
  it('reads each phase’s duration', () => {
    expect(parseServerTiming('auth;dur=12.3, build;dur=0.8, total;dur=40')).toEqual({ auth: 12.3, build: 0.8, total: 40 });
  });

  it('takes the duration wherever it sits among the parameters, and skips an entry with none', () => {
    expect(parseServerTiming('cache;desc="hit", db;desc="x";dur=3.5,  edge')).toEqual({ db: 3.5 });
  });

  it('reads nothing from a response that sent no header', () => {
    expect(parseServerTiming(null)).toEqual({});
    expect(parseServerTiming('')).toEqual({});
  });
});

describe('phaseSamples and row', () => {
  it('collects each phase over the responses that carried it', () => {
    expect(phaseSamples([{ auth: 1, total: 5 }, { auth: 2, gate: 3, total: 6 }, {}])).toEqual({ auth: [1, 2], gate: [3], total: [5, 6] });
  });

  it('prints one line per name', () => {
    expect(row('tools/call', summarise([100, 200, 600])!)).toBe('tools/call n=3    p50    200  p95    600  p99    600  max    600  >500ms 1');
  });
});
