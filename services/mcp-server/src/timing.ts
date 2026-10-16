/**
 * Where the time of one POST /mcp goes (issue #47).
 *
 * Each request is timed in phases, measured where the work is done:
 *
 *   auth     the bearer token's check (one GetItem), before the route runs
 *   build    making this request's MCP server and connecting its transport
 *   gate     INV-9's question, asked inside the tool (tools/context.ts `gated`),
 *            and for a tool that asks after the resident, noting the look
 *   handler  the tool's own reads and writes
 *   guard    the Guardian reading the answer (guardian.ts)
 *   total    from the request's arrival to its answer's headers
 *
 * The phases go back to the caller as a `Server-Timing` header and into the
 * log as one JSON line per request (`mcp_request`). Neither carries anything
 * about a person: no token, no id, no household, no arguments, no answer —
 * the JSON-RPC method, the tool's name, the status and the milliseconds.
 */
import { performance } from 'node:perf_hooks';
import type express from 'express';

export const PHASES = ['auth', 'build', 'gate', 'handler', 'guard'] as const;
export type Phase = (typeof PHASES)[number];

/** What a phase's timer is handed: add milliseconds to it. A request may cross a phase more than once (a batch). */
export interface PhaseTimer {
  add(phase: Phase, ms: number): void;
}

/** Times `work` into `phase` of `timer`, if there is one. */
export async function timed<T>(timer: PhaseTimer | undefined, phase: Phase, work: () => Promise<T>): Promise<T> {
  if (!timer) return work();
  const start = performance.now();
  try {
    return await work();
  } finally {
    timer.add(phase, performance.now() - start);
  }
}

export class RequestTiming implements PhaseTimer {
  readonly #start = performance.now();
  readonly #phases = new Map<Phase, number>();
  #total: number | undefined;

  add(phase: Phase, ms: number): void {
    this.#phases.set(phase, (this.#phases.get(phase) ?? 0) + ms);
  }

  /** Since the request arrived. */
  elapsed(): number {
    return performance.now() - this.#start;
  }

  /** Fixes the total: called once, when the answer's headers are written. */
  end(): number {
    this.#total ??= this.elapsed();
    return this.#total;
  }

  /** Milliseconds per phase, to one decimal, in the order above; `total` last. */
  summary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const phase of PHASES) {
      const ms = this.#phases.get(phase);
      if (ms !== undefined) out[phase] = round(ms);
    }
    out.total = round(this.end());
    return out;
  }

  /** The `Server-Timing` header (W3C Server Timing): `auth;dur=12.3, build;dur=0.8, …`. */
  header(): string {
    return Object.entries(this.summary())
      .map(([name, ms]) => `${name};dur=${ms}`)
      .join(', ');
  }
}

const round = (ms: number): number => Math.round(ms * 10) / 10;

const TIMING = Symbol('wickTiming');
type Timed = express.Response & { [TIMING]?: RequestTiming };

/** This request's timing, made by `startTiming`. */
export const timingOf = (res: express.Response): RequestTiming | undefined => (res as Timed)[TIMING];

/** What one request's log line says about the call it carried: never its arguments. */
function callOf(body: unknown): { rpc: string; tool?: string } {
  const one = Array.isArray(body) ? (body.length === 1 ? body[0] : undefined) : body;
  if (Array.isArray(body) && body.length !== 1) return { rpc: 'batch' };
  const message = one as { method?: unknown; params?: { name?: unknown } } | undefined;
  const rpc = typeof message?.method === 'string' ? message.method : 'unknown';
  const tool = rpc === 'tools/call' && typeof message?.params?.name === 'string' ? message.params.name : undefined;
  // A tool's name is one of a fixed set; anything else is not repeated back into the log.
  return tool !== undefined && /^[a-z_]{1,64}$/.test(tool) ? { rpc, tool } : { rpc };
}

/**
 * The first middleware of POST /mcp: starts the clock, writes
 * `Server-Timing` onto the answer the moment its headers go, and logs one
 * line when it has gone.
 */
export function startTiming(log: (line: string) => void = (line) => console.log(line)): express.RequestHandler {
  return (req, res, next) => {
    const timing = new RequestTiming();
    (res as Timed)[TIMING] = timing;

    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => express.Response;
    res.writeHead = ((...args: unknown[]) => {
      if (!res.headersSent) res.setHeader('server-timing', timing.header());
      return writeHead(...args);
    }) as typeof res.writeHead;

    res.once('finish', () => {
      log(JSON.stringify({ level: 'info', msg: 'mcp_request', ...callOf(req.body), status: res.statusCode, ms: timing.summary() }));
    });
    next();
  };
}

/** Marks the end of the token check: everything from the request's arrival to here was `auth`. */
export function authChecked(): express.RequestHandler {
  return (_req, res, next) => {
    const timing = timingOf(res);
    timing?.add('auth', timing.elapsed());
    next();
  };
}
