/**
 * The arithmetic behind `npm run latency:mcp` (scripts/mcp-latency.ts), kept
 * apart so it is tested without a network.
 */

/** The p-th percentile (0–100) by nearest rank, or undefined for no samples. */
export function percentile(samples: readonly number[], p: number): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** `auth;dur=12.3, build;dur=0.8;desc="x", total;dur=40` → { auth: 12.3, build: 0.8, total: 40 }. Entries without a duration are skipped. */
export function parseServerTiming(header: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of (header ?? '').split(',')) {
    const [name, ...params] = entry.trim().split(';');
    if (!name) continue;
    const dur = params.map((param) => param.trim()).find((param) => param.startsWith('dur='));
    const ms = dur === undefined ? Number.NaN : Number(dur.slice(4));
    if (Number.isFinite(ms)) out[name] = ms;
  }
  return out;
}

export interface Summary {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  /** How many samples were over `limitMs`. */
  readonly over: number;
}

export function summarise(samples: readonly number[], limitMs = 500): Summary | undefined {
  if (samples.length === 0) return undefined;
  return {
    n: samples.length,
    p50: percentile(samples, 50)!,
    p95: percentile(samples, 95)!,
    p99: percentile(samples, 99)!,
    max: Math.max(...samples),
    over: samples.filter((ms) => ms > limitMs).length,
  };
}

/** One row of the printed table: `name  n=100  p50 212  p95 840  p99 1104  max 1180  >500ms 31`. */
export function row(name: string, summary: Summary, limitMs = 500): string {
  const ms = (value: number): string => (value >= 100 ? value.toFixed(0) : value.toFixed(1));
  return `${name.padEnd(9)} n=${String(summary.n).padEnd(4)} p50 ${ms(summary.p50).padStart(6)}  p95 ${ms(summary.p95).padStart(6)}  p99 ${ms(summary.p99).padStart(6)}  max ${ms(summary.max).padStart(6)}  >${limitMs}ms ${summary.over}`;
}

/** Per phase, the samples of every response that carried that phase. */
export function phaseSamples(timings: readonly Record<string, number>[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const timing of timings) {
    for (const [phase, ms] of Object.entries(timing)) (out[phase] ??= []).push(ms);
  }
  return out;
}
