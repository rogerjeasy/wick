/**
 * The live graph — M2, "Watch live", as a Strands Graph.
 *
 *   gate ──(passed)──▶ start
 *
 * Deterministic, like the chime: whether a television may watch the front
 * door is policy (live/gate.ts), never a model's call. `start` starts — or
 * joins — the household's one live bridge, which then keeps streaming in
 * this AgentCore session after the graph has answered.
 */
import { Graph } from '@strands-agents/sdk';
import type { LiveErrorResponse, LiveSessionResponse } from '@wick/contracts';
import { LiveStartError } from '../live/bridge.js';
import { gateLiveRequest, type LiveGateDeps, type LiveGateOutcome } from '../live/gate.js';
import type { LiveSession } from '../live/registry.js';
import { StepNode, assertCompleted, pathOf, when } from './step.js';
import type { GraphRun } from './doorAction.js';

export const LIVE_NODES = { gate: 'gate', start: 'start' } as const;

export interface LiveGraphDeps extends LiveGateDeps {
  readonly startLive: (householdId: string, ringDeviceId: string) => Promise<LiveSession>;
  readonly playlistUrl: (sessionId: string) => string;
}

export type LiveGraphResult = LiveSessionResponse | LiveErrorResponse;

export async function runLiveGraph(
  req: { readonly householdId: string; readonly cardId: string },
  deps: LiveGraphDeps,
): Promise<GraphRun<LiveGraphResult>> {
  let result: LiveGraphResult | undefined;

  const gate = new StepNode(LIVE_NODES.gate, async (ctx) => {
    const g = await gateLiveRequest(req, deps);
    ctx.set('gate', g);
    if (!g.pass) result = { error: g.refusal };
    return g.pass ? 'passed' : g.refusal;
  }, 'A fresh DOOR card of this household that offered Watch live, and its camera');

  const start = new StepNode(LIVE_NODES.start, async (ctx) => {
    const g = ctx.get<Extract<LiveGateOutcome, { pass: true }>>('gate')!;
    try {
      const session = await deps.startLive(req.householdId, g.ringDeviceId);
      result = { sessionId: session.sessionId, playlistUrl: deps.playlistUrl(session.sessionId), endsAt: session.endsAt };
      return 'started';
    } catch (err) {
      if (!(err instanceof LiveStartError)) throw err;
      result = { error: err.refusal };
      return err.refusal;
    }
  }, 'Start or join the household\'s live bridge');

  const graph = new Graph({
    id: 'live',
    nodes: [gate, start],
    edges: [{ source: gate.id, target: start.id, handler: when<LiveGateOutcome>('gate', (g) => g.pass) }],
    // WHEP answers in ~1.5s; past this the camera isn't answering.
    timeout: 10_000,
  });

  const run = await graph.invoke(req.cardId);
  assertCompleted(graph.id, run);
  if (!result) throw new Error('live graph finished without a result');
  return { result, path: pathOf(run) };
}
