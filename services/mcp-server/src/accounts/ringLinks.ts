/**
 * The home's Ring link, reached by invoking the linking function
 * (services/edge-ring/lambda/household-link.mjs).
 *
 * This server never holds a Ring token and never reads a Ring secret: it
 * decides who is asking and for which home (accounts/apiRouter.ts, `/api/ring`)
 * and hands exactly that — an action and a household — to the one function
 * that has custody. The function is on no public route; only this server's
 * role may invoke it.
 */
import type { RingLinkAnswer, RingLinks } from './apiRouter.js';

/** Calls the linking function with one request and returns what it answered. */
export type InvokeRingLink = (request: Record<string, unknown>) => Promise<unknown>;

const FAILED: RingLinkAnswer = { ok: false, error: 'failed' };

export function invokedRingLinks(invoke: InvokeRingLink): RingLinks {
  const ask = async (request: Record<string, unknown>): Promise<RingLinkAnswer> => {
    const answer = await invoke(request);
    // A function that fell over answers with an error document, not an answer.
    return typeof answer === 'object' && answer !== null && typeof (answer as { ok?: unknown }).ok === 'boolean'
      ? (answer as RingLinkAnswer)
      : FAILED;
  };
  return {
    status: (householdId) => ask({ action: 'status', householdId }),
    start: (householdId, userId) => ask({ action: 'start', householdId, userId }),
    playground: (householdId, userId, token) => ask({ action: 'playground', householdId, userId, token }),
    disconnect: (householdId) => ask({ action: 'disconnect', householdId }),
  };
}
