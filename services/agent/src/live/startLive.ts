/**
 * The live graph's `start` step (graphs/live.ts), on the AgentCore side.
 *
 * The media bridge can't run here — the AgentCore microVM has no outbound
 * UDP, and WebRTC needs it (FL-017) — so this claims the household's one
 * live session and hands it to the bridge Lambda, asynchronously: the TV gets
 * its playlist URL at once and the first segments follow ~6s later. A second
 * press, or a second television, joins the session already streaming.
 */
import { LIVE_MAX_MS } from '@wick/contracts';
import { LiveStartError } from './bridge.js';
import type { LiveClaim } from './sessions.js';

export interface LiveSession {
  readonly sessionId: string;
  readonly endsAt: number;
}

export interface BridgeJob {
  readonly householdId: string;
  readonly sessionId: string;
  readonly ringDeviceId: string;
  /** Epoch ms. Ring's limit for a line-powered doorbell; the bridge stops by then. */
  readonly endsAt: number;
}

export interface StartLiveDeps {
  readonly claim: (householdId: string, sessionId: string, now: number, endsAt: number) => Promise<LiveClaim>;
  readonly release: (householdId: string, sessionId: string) => Promise<void>;
  /** An asynchronous (Event) invoke of the bridge Lambda. */
  readonly invokeBridge: (job: BridgeJob) => Promise<void>;
  readonly newSessionId: () => string;
  readonly now: () => number;
}

export async function startLive(householdId: string, ringDeviceId: string, deps: StartLiveDeps): Promise<LiveSession> {
  const now = deps.now();
  const claim = await deps.claim(householdId, deps.newSessionId(), now, now + LIVE_MAX_MS);
  if (claim.joined) return { sessionId: claim.sessionId, endsAt: claim.endsAt };

  try {
    await deps.invokeBridge({ householdId, sessionId: claim.sessionId, ringDeviceId, endsAt: claim.endsAt });
  } catch {
    await deps.release(householdId, claim.sessionId);
    throw new LiveStartError('camera_unavailable');
  }
  return { sessionId: claim.sessionId, endsAt: claim.endsAt };
}
