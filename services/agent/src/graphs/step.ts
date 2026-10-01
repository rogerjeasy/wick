/**
 * A deterministic step as a Strands graph node.
 *
 * Strands' Graph orchestrates Agents, but a node is any `Node` subclass — so
 * the parts of the agent plane that must never be a model's decision (the
 * Guardian, a gate before a chime makes a sound, starting a live session)
 * sit in the same graph as the parts that are, with the graph's own
 * ordering, tracing and conditional edges around them.
 *
 * Steps talk through `state.app` (JSON only, per-invocation). Edges read it
 * too: `when(key, predicate)` is the edge handler for "only continue if the
 * gate said so".
 */
import { Node, Status, type MultiAgentResult, type MultiAgentState, type NodeInputOptions, type NodeResultUpdate, type MultiAgentStreamEvent, type MultiAgentInput } from '@strands-agents/sdk/multiagent';
import { TextBlock, type JSONValue } from '@strands-agents/sdk';

export interface StepContext {
  readonly get: <T>(key: string) => T | undefined;
  readonly set: (key: string, value: unknown) => void;
  /** The text an upstream node (typically an Agent) produced. */
  readonly output: (nodeId: string) => string;
}

export type Step = (ctx: StepContext) => Promise<string | void>;

export class StepNode extends Node {
  override readonly type = 'stepNode';
  readonly #step: Step;

  constructor(id: string, step: Step, description?: string) {
    super(id, description ? { description } : {});
    this.#step = step;
  }

  async *handle(
    _input: MultiAgentInput,
    state: MultiAgentState,
    _options?: NodeInputOptions,
  ): AsyncGenerator<MultiAgentStreamEvent, NodeResultUpdate, undefined> {
    const note = await this.#step(contextFor(state));
    return note ? { content: [new TextBlock(note)] } : {};
  }
}

function contextFor(state: MultiAgentState): StepContext {
  return {
    get: <T>(key: string) => state.app.get(key) as T | undefined,
    set: (key, value) => state.app.set(key, value as JSONValue),
    output: (nodeId) =>
      (state.node(nodeId)?.content ?? [])
        .map((b) => (b.type === 'textBlock' ? b.text : ''))
        .join(''),
  };
}

/** Edge handler: traverse only when `state.app[key]` satisfies `predicate`. */
export function when<T>(key: string, predicate: (value: T) => boolean) {
  return (state: MultiAgentState): boolean => {
    const value = state.app.get(key) as T | undefined;
    return value !== undefined && predicate(value);
  };
}

/** The ids of the nodes that completed, in order — what a run actually did. */
export function pathOf(result: MultiAgentResult): string[] {
  return result.results.filter((r) => r.status === Status.COMPLETED).map((r) => r.nodeId);
}

/** A failed node fails the run, loudly, naming where. */
export function assertCompleted(graphId: string, result: MultiAgentResult): void {
  const failed = result.results.find((r) => r.status !== Status.COMPLETED);
  if (failed) throw new Error(`${graphId} graph failed at ${failed.nodeId}: ${failed.error?.message ?? failed.status}`);
}
