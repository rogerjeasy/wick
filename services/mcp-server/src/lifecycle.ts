/**
 * How the Wick server starts, says it is alive, and stops.
 *
 *   - `GET /health` is App Runner's health check (infra/mcp.tf). It reads
 *     nothing — no table, no token — so a slow DynamoDB never makes App
 *     Runner restart a server that is answering. It says which build is
 *     running, and `draining` once the server has been told to stop.
 *   - `serve` listens with keep-alive held longer than the proxy in front
 *     keeps an idle connection, so the proxy never sends a request down a
 *     connection this process is closing.
 *   - SIGTERM (App Runner replacing the instance) or SIGINT: stop accepting,
 *     let the requests in flight finish within a bound, close every
 *     connection, and exit 0. A request still running at the bound is cut
 *     off and logged as a count.
 */
import type { Server } from 'node:http';
import type express from 'express';

/** Whether the server has been told to stop. Shared by the health route and `serve`. */
export interface Lifecycle {
  readonly draining: boolean;
  drain(): void;
}

export function createLifecycle(): Lifecycle {
  let draining = false;
  return {
    get draining() {
      return draining;
    },
    drain() {
      draining = true;
    },
  };
}

/** What the health route says the running build is. Absent values are left out. */
export interface About {
  readonly version: string;
  readonly commit?: string | undefined;
}

export function healthRoute(lifecycle: Lifecycle, about: About, startedAt: number = Date.now()): express.RequestHandler {
  return (_req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.status(lifecycle.draining ? 503 : 200).json({
      status: lifecycle.draining ? 'draining' : 'ok',
      version: about.version,
      ...(about.commit ? { commit: about.commit } : {}),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
  };
}

/**
 * Once draining, every answer says the connection closes after it: a
 * client holding a kept-alive connection opens its next one elsewhere.
 */
export function closeWhenDraining(lifecycle: Lifecycle): express.RequestHandler {
  return (_req, res, next) => {
    if (lifecycle.draining) res.setHeader('connection', 'close');
    next();
  };
}

/**
 * Longer than the load balancer in front keeps an idle connection open
 * (App Runner's is not documented; 60 s is the usual figure for Envoy and
 * ALB), so it is always the proxy that closes an idle one, never this
 * process mid-request.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
/** How long the requests in flight are given to finish once the server is told to stop. */
export const DRAIN_TIMEOUT_MS = 10_000;

export type Stopped = { readonly how: 'drained' } | { readonly how: 'forced'; readonly cutOff: number };

export interface Running {
  readonly server: Server;
  readonly port: number;
  /** Stop accepting, let what is in flight finish within `drainMs`, close every connection. */
  stop(drainMs?: number): Promise<Stopped>;
}

export function serve(app: express.Express, lifecycle: Lifecycle, port: number, host?: string): Promise<Running> {
  return new Promise((resolve, reject) => {
    let inFlight = 0;
    const onListening = (): void => {
      const address = server.address();
      resolve({
        server,
        port: typeof address === 'object' && address ? address.port : port,
        stop: (drainMs = DRAIN_TIMEOUT_MS) => stop(drainMs),
      });
    };
    const server = host === undefined ? app.listen(port, onListening) : app.listen(port, host, onListening);
    server.once('error', reject);
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    // Node's own advice: longer than keepAliveTimeout, or a slow client's headers race the idle close.
    server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1_000;

    server.on('request', (_req, res) => {
      inFlight += 1;
      res.once('close', () => {
        inFlight -= 1;
        // A kept-alive connection that has just finished its answer is idle now: let it go.
        if (lifecycle.draining) server.closeIdleConnections();
      });
    });

    let stopping: Promise<Stopped> | undefined;
    const stop = (drainMs: number): Promise<Stopped> =>
      (stopping ??= new Promise<Stopped>((done) => {
        lifecycle.drain();
        const timer = setTimeout(() => {
          const cutOff = inFlight;
          server.closeAllConnections();
          done({ how: 'forced', cutOff });
        }, drainMs);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          done({ how: 'drained' });
        });
        server.closeIdleConnections();
      }));
  });
}

/** Stops on SIGTERM or SIGINT, logs how, and exits 0. Returns how to stop listening for them. */
export function stopOnSignals(running: Running, exit: (code: number) => void = (code) => process.exit(code)): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    forget();
    console.log(JSON.stringify({ level: 'info', msg: 'shutdown_started', signal }));
    void running.stop().then((stopped) => {
      console.log(JSON.stringify({ level: stopped.how === 'drained' ? 'info' : 'warn', msg: 'shutdown_finished', ...stopped }));
      exit(0);
    });
  };
  const forget = (): void => {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  return forget;
}
