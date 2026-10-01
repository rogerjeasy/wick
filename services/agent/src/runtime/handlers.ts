/**
 * Runtime handlers: one per invocation kind, each running a Strands graph.
 *
 * Pure of AWS: every handler takes a deps factory, and main.ts — the
 * container's composition root — supplies the real DynamoDB, Ring and
 * egress clients.
 */
import type { CardActionDeps } from '../agents/door/actions.js';
import { runDoorActionGraph } from '../graphs/doorAction.js';
import { runLiveGraph, type LiveGraphDeps } from '../graphs/live.js';
import { runDescribeGraph } from '../graphs/doorDescribe.js';
import type { Model } from '@strands-agents/sdk';
import type { LiveRegistry } from '../live/registry.js';
import type { RuntimeHandler } from './server.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `door.action` — M1. `payload.householdId` is the session's household (invoke.ts). */
export function doorActionHandler(depsFor: (householdId: string) => CardActionDeps): RuntimeHandler {
  return async (payload) => {
    const { householdId, detail } = payload;
    if (typeof householdId !== 'string' || !isRecord(detail) || detail.householdId !== householdId) {
      return { result: 'ignored', path: [] };
    }
    return runDoorActionGraph(detail, depsFor(householdId));
  };
}

/** `live.start` — M2. Answers the live-start Lambda; the bridge keeps running here afterwards. */
export function liveStartHandler(depsFor: (householdId: string) => LiveGraphDeps): RuntimeHandler {
  return async (payload) => {
    const { householdId, cardId } = payload;
    if (typeof householdId !== 'string' || typeof cardId !== 'string' || !cardId) return { error: 'bad_request' };
    return (await runLiveGraph({ householdId, cardId }, depsFor(householdId))).result;
  };
}

/** `live.stop` — the resident pressed Back. Lands in the same session as the bridge it stops. */
export function liveStopHandler(registry: LiveRegistry): RuntimeHandler {
  return async (payload) => {
    const { householdId, sessionId } = payload;
    if (typeof householdId !== 'string' || typeof sessionId !== 'string') return { stopped: false };
    return { stopped: registry.stop(householdId, sessionId) };
  };
}

/**
 * `door.describe` — Phase 2b. The door Lambda has already fetched the frame
 * (it is also the image patch) and sends it here base64; the answer is a
 * DescribeResult, and the Lambda patches the card exactly as before.
 */
export function doorDescribeHandler(modelFor: () => Model): RuntimeHandler {
  return async (payload) => {
    const { frame, format } = payload;
    if (typeof frame !== 'string' || !frame) return { candidate: null, reason: 'no frame', elapsedMs: 0 };
    const bytes = new Uint8Array(Buffer.from(frame, 'base64'));
    const run = await runDescribeGraph(bytes, { model: modelFor(), format: format === 'png' ? 'png' : 'jpeg' });
    return run.result;
  };
}
