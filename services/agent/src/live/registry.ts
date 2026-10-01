/**
 * The live bridges running in this runtime session.
 *
 * Session = household (runtime/invoke.ts), so this is in practice one
 * household's microVM; it is keyed by household anyway, so the rule — one
 * live view per household, and a second press or a second television joins
 * it — never depends on that.
 *
 * Session ids are 128 random bits: they are the only thing between the
 * published playlist and anyone who guesses its URL.
 */
import { randomBytes } from 'node:crypto';
import type { RunningBridge } from './bridge.js';

export interface LiveSession {
  readonly sessionId: string;
  readonly endsAt: number;
}

export class LiveRegistry {
  /** Starting or running, per household. A start in flight is joined, not raced. */
  readonly #pending = new Map<string, Promise<RunningBridge>>();
  /** Running, per household — what stop() can act on. */
  readonly #running = new Map<string, RunningBridge>();

  start(householdId: string, startBridge: (sessionId: string) => Promise<RunningBridge>): Promise<LiveSession> {
    let pending = this.#pending.get(householdId);
    if (!pending) {
      const mine = startBridge(randomBytes(16).toString('base64url'));
      pending = mine;
      this.#pending.set(householdId, mine);

      const forget = () => {
        if (this.#pending.get(householdId) !== mine) return;
        this.#pending.delete(householdId);
        this.#running.delete(householdId);
      };
      mine.then(
        (bridge) => {
          this.#running.set(householdId, bridge);
          void bridge.done.finally(forget);
        },
        forget,
      );
    }
    return pending.then((b) => ({ sessionId: b.sessionId, endsAt: b.endsAt }));
  }

  /** True when this asked a running session to stop. */
  stop(householdId: string, sessionId: string): boolean {
    const bridge = this.#running.get(householdId);
    if (!bridge || bridge.sessionId !== sessionId) return false;
    bridge.stop();
    return true;
  }

  /** AgentCore's /ping: keep this session while a stream is starting or running. */
  busy(): boolean {
    return this.#pending.size > 0;
  }
}
