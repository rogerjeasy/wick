/**
 * One live session in the bridge Lambda (live/bridgeLambda.ts): run the
 * WHEP→HLS bridge until Ring's deadline, the resident's Back, or Ring ending
 * it — and always give the household's claim back, so the next press works.
 *
 * Back reaches here as a flag on LIVE#active (sessions.ts), polled every
 * couple of seconds: cheap, and a stop that lands a second or two late
 * costs nothing — the TV has already left the view.
 */
import { LiveStartError, type BridgeEnd, type RunningBridge } from './bridge.js';
import type { BridgeJob } from './startLive.js';

export interface BridgeJobDeps {
  readonly start: (sessionId: string, ringDeviceId: string, maxMs: number) => Promise<RunningBridge>;
  readonly isStopRequested: (householdId: string, sessionId: string) => Promise<boolean>;
  readonly release: (householdId: string, sessionId: string) => Promise<void>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly stopPollMs: number;
}

export type BridgeJobResult = BridgeEnd | 'expired' | LiveStartError['refusal'];

export async function runBridgeJob(job: BridgeJob, deps: BridgeJobDeps): Promise<BridgeJobResult> {
  try {
    const maxMs = job.endsAt - deps.now();
    if (maxMs <= 0) return 'expired';

    let bridge: RunningBridge;
    try {
      bridge = await deps.start(job.sessionId, job.ringDeviceId, maxMs);
    } catch (err) {
      if (err instanceof LiveStartError) return err.refusal;
      throw err;
    }

    let finished = false;
    void bridge.done.finally(() => {
      finished = true;
    });

    const watch = (async () => {
      while (!finished) {
        try {
          if (await deps.isStopRequested(job.householdId, job.sessionId)) {
            bridge.stop();
            return;
          }
        } catch {
          // A failed check is not a stop; Ring's own limit still ends it.
        }
        await deps.sleep(deps.stopPollMs);
      }
    })();

    const end = await bridge.done;
    finished = true;
    await watch;
    return end;
  } finally {
    await deps.release(job.householdId, job.sessionId);
  }
}
