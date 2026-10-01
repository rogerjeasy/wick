/**
 * The door-action graph — M1, "Ring the hallway chime", as a Strands Graph.
 *
 *   gate ──(passed)──▶ ring ──▶ notify
 *
 * Three deterministic nodes and no Agent: no model ever decides to make a
 * sound in someone's home (spec D4). The graph is still the right shape: it
 * runs inside the household's AgentCore Runtime session alongside the door
 * graph that described the visitor a moment earlier, and the conditional
 * edge makes the safety rule structural — the ring node is unreachable
 * unless the gate passed.
 */
import { Graph } from '@strands-agents/sdk';
import {
  chimePatch,
  gateChimePress,
  ringHallwayChimes,
  type CardActionDeps,
  type CardActionResult,
  type ChimeResult,
  type GateOutcome,
} from '../agents/door/actions.js';
import { StepNode, assertCompleted, pathOf, when } from './step.js';

export const DOOR_ACTION_NODES = { gate: 'gate', ring: 'ring', notify: 'notify' } as const;

export interface GraphRun<R> {
  readonly result: R;
  /** Node ids that completed, in order. */
  readonly path: readonly string[];
}

/**
 * Built per press: the nodes close over this press's deps, and `outcome()`
 * reads what the run decided (a MultiAgentResult carries node content, not
 * the app state).
 */
export function buildDoorActionGraph(
  raw: Record<string, unknown>,
  deps: CardActionDeps,
): { graph: Graph; outcome: () => CardActionResult | undefined } {
  let outcome: CardActionResult | undefined;

  const gate = new StepNode(DOOR_ACTION_NODES.gate, async (ctx) => {
    const g = await gateChimePress(raw, deps);
    ctx.set('gate', g);
    if (!g.pass) outcome = g.result;
    return g.pass ? 'passed' : g.result;
  }, 'Live DOOR card that offered the button, not expired, claimed exactly once');

  const ring = new StepNode(DOOR_ACTION_NODES.ring, async (ctx) => {
    const result = await ringHallwayChimes(deps);
    ctx.set('chime', result);
    return result;
  }, 'Play every household chime once; never retried');

  const notify = new StepNode(DOOR_ACTION_NODES.notify, async (ctx) => {
    const passed = ctx.get<Extract<GateOutcome, { pass: true }>>('gate')!;
    const result = ctx.get<ChimeResult>('chime')!;
    await deps.sendPatch(chimePatch(passed.queued, result));
    outcome = result;
    return 'patched';
  }, 'Tell the resident, on the same card, what happened');

  const graph = new Graph({
    id: 'door-action',
    nodes: [gate, ring, notify],
    edges: [
      { source: gate.id, target: ring.id, handler: when<GateOutcome>('gate', (g) => g.pass) },
      [ring.id, notify.id],
    ],
    // Status re-read, configurations, playback per chime: a few Ring round trips.
    timeout: 12_000,
  });

  return { graph, outcome: () => outcome };
}

export async function runDoorActionGraph(
  raw: Record<string, unknown>,
  deps: CardActionDeps,
): Promise<GraphRun<CardActionResult>> {
  const { graph, outcome } = buildDoorActionGraph(raw, deps);
  const run = await graph.invoke(JSON.stringify(raw));
  assertCompleted(graph.id, run);

  const result = outcome();
  if (!result) throw new Error('door-action graph finished without an outcome');
  return { result, path: pathOf(run) };
}
