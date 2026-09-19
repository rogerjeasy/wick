/**
 * SSE consumer for /v1/stream.
 * The 120s idle timeout will fight a long-lived consumer — expect heartbeat +
 * reconnect, and write it up (SP-6).
 *
 * Runs on the household bridge (§7.2), a small always-on process beside the
 * proxy. `parseSseFrames` is the pure half — one function, fully testable
 * without a socket. `BeeSseConsumer` owns the actual fetch/stream/reconnect
 * loop, `fetchImpl`-injected the same way proxy.ts is.
 */
import { BEE_PROXY_BASE } from './proxy.js';
import type { BeeStreamEvent } from './types.js';

export type Unsubscribe = () => void;

/**
 * Splits an accumulated SSE buffer into complete `\n\n`-terminated frames
 * plus whatever incomplete tail remains. Each frame's `data:` lines are
 * joined and JSON-parsed into a BeeStreamEvent; a frame with no `data:`
 * line (a bare SSE comment/keep-alive, e.g. `: ping`) yields no event and
 * is not an error — that is exactly the heartbeat this module exists to
 * tolerate.
 */
export function parseSseFrames(buffer: string): { events: readonly BeeStreamEvent[]; remainder: string } {
  const frames = buffer.split('\n\n');
  const remainder = frames.pop() ?? '';
  const events: BeeStreamEvent[] = [];

  for (const frame of frames) {
    const dataLines = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim());
    if (dataLines.length === 0) continue; // heartbeat/comment frame

    try {
      events.push(JSON.parse(dataLines.join('\n')) as BeeStreamEvent);
    } catch {
      // A frame that isn't valid JSON is dropped, not thrown — one malformed
      // heartbeat must never take the whole household's stream down.
    }
  }

  return { events, remainder };
}

export interface BeeSseConsumerOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly eventTypes?: readonly string[];
  /** Reconnect if nothing (event or heartbeat) arrives within this window. Proxy default idle is 120s (§7.2). */
  readonly idleTimeoutMs?: number;
  /** Reconnect backoff schedule, ms. The last value repeats. */
  readonly backoffMs?: readonly number[];
  readonly setTimeoutImpl?: typeof setTimeout;
  readonly clearTimeoutImpl?: typeof clearTimeout;
}

const DEFAULT_IDLE_TIMEOUT_MS = 90_000; // reconnect before the proxy's own 120s idle timeout fires
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Long-lived SSE consumer with heartbeat-driven reconnect. `start()` never
 * throws — a connection failure schedules the next attempt on the backoff
 * schedule instead of propagating, because there is no caller in a position
 * to retry a background bridge process's stream for it.
 */
export class BeeSseConsumer {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #eventTypes: readonly string[] | undefined;
  readonly #idleTimeoutMs: number;
  readonly #backoffMs: readonly number[];
  readonly #setTimeoutImpl: typeof setTimeout;
  readonly #clearTimeoutImpl: typeof clearTimeout;

  readonly #handlers = new Set<(e: BeeStreamEvent) => void>();
  #stopped = true;
  #attempt = 0;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #abort: AbortController | undefined;

  constructor(options: BeeSseConsumerOptions = {}) {
    this.#baseUrl = options.baseUrl ?? BEE_PROXY_BASE;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#eventTypes = options.eventTypes;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.#setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.#clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  }

  onEvent(handler: (e: BeeStreamEvent) => void): Unsubscribe {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#attempt = 0;
    void this.#connectLoop();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimeoutImpl(this.#idleTimer);
    this.#clearTimeoutImpl(this.#reconnectTimer);
    this.#abort?.abort();
    this.#abort = undefined;
  }

  #path(): string {
    const q = this.#eventTypes?.length ? `?event_type=${this.#eventTypes.map(encodeURIComponent).join(',')}` : '';
    return `/v1/stream${q}`;
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    const delay = this.#backoffMs[Math.min(this.#attempt, this.#backoffMs.length - 1)] ?? 30_000;
    this.#attempt += 1;
    this.#reconnectTimer = this.#setTimeoutImpl(() => void this.#connectLoop(), delay);
  }

  #resetIdleTimer(onIdle: () => void): void {
    this.#clearTimeoutImpl(this.#idleTimer);
    this.#idleTimer = this.#setTimeoutImpl(onIdle, this.#idleTimeoutMs);
  }

  async #connectLoop(): Promise<void> {
    if (this.#stopped) return;

    this.#abort = new AbortController();
    let buffer = '';

    try {
      const res = await this.#fetch(`${this.#baseUrl}${this.#path()}`, { signal: this.#abort.signal });
      if (!res.ok || !res.body) throw new Error(`bee_sse_${res.status}`);

      this.#attempt = 0; // a successful connect resets backoff
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf8');

      // No event within the idle window (including heartbeats) — abort and
      // let the catch below schedule a reconnect. The proxy's own 120s idle
      // timeout would otherwise close this out from under us with no signal.
      this.#resetIdleTimer(() => this.#abort?.abort());

      for (;;) {
        if (this.#stopped) return;
        const { done, value } = await reader.read();
        if (done) break;

        this.#resetIdleTimer(() => this.#abort?.abort());
        buffer += decoder.decode(value, { stream: true });
        const { events, remainder } = parseSseFrames(buffer);
        buffer = remainder;
        for (const event of events) {
          for (const handler of this.#handlers) handler(event);
        }
      }

      throw new Error('bee_sse_closed');
    } catch {
      // Deliberately swallowed — see the class doc comment. Connection loss,
      // an idle-triggered abort, and a non-OK status all land here the same
      // way, and all get the same treatment: reconnect on backoff.
    } finally {
      this.#clearTimeoutImpl(this.#idleTimer);
      this.#scheduleReconnect();
    }
  }
}
