/**
 * The door's describe graph — Phase 2b, the sentence, as a Strands Graph.
 *
 *   describe (Strands Agent · Bedrock Nova Lite · vision) ──▶ validate
 *
 * "The hard part is not the card. It is the description." The agent sees
 * one frame and answers in two lines (PERSON: yes|no, then the sentence).
 * It has no tools on purpose: a vision agent with roster access could name
 * a stranger at someone's door.
 *
 * The validate node is the deterministic half — the same judge describe.ts
 * uses — because a prompt is a request and a visitor's t-shirt is untrusted
 * text in a vision prompt. Whatever the agent says, only a sentence the
 * validator accepts leaves this graph.
 *
 * Never throws: a model failure, a timeout or a refusal all mean the same
 * thing to the resident — the Phase 1 card stands.
 */
import { Agent, BedrockModel, Graph, ImageBlock, TextBlock, type Model } from '@strands-agents/sdk';
import { Status } from '@strands-agents/sdk/multiagent';
import { DESCRIBE_MODEL_ID, DESCRIBE_REGION, DESCRIBE_SYSTEM_PROMPT, DESCRIBE_TIMEOUT_MS, judgeDescribeReply, type DescribeResult } from '../agents/door/describe.js';
import { StepNode, pathOf } from './step.js';
import type { GraphRun } from './doorAction.js';

export const DESCRIBE_NODES = { describe: 'describe', validate: 'validate' } as const;

export function describeModel(): Model {
  return new BedrockModel({ modelId: DESCRIBE_MODEL_ID, region: DESCRIBE_REGION, maxTokens: 60, temperature: 0.2 });
}

export function buildDescribeAgent(model: Model): Agent {
  return new Agent({
    id: DESCRIBE_NODES.describe,
    name: 'door-describe',
    description: 'Describes one doorbell frame in one plain sentence, or declines.',
    model,
    systemPrompt: DESCRIBE_SYSTEM_PROMPT,
    tools: [],
    printer: false,
    // A late description is worse than none: no retries inside the budget.
    retryStrategy: null,
  });
}

export async function runDescribeGraph(
  frame: Uint8Array,
  options: { readonly model?: Model; readonly format?: 'jpeg' | 'png' } = {},
): Promise<GraphRun<DescribeResult>> {
  const started = Date.now();
  let judged: Omit<DescribeResult, 'elapsedMs'> | undefined;

  const agent = buildDescribeAgent(options.model ?? describeModel());
  const validate = new StepNode(DESCRIBE_NODES.validate, async (ctx) => {
    judged = judgeDescribeReply(ctx.output(DESCRIBE_NODES.describe));
    return judged.reason;
  }, 'One sentence, ≤14 words, no speculation — or nothing');

  const graph = new Graph({
    id: 'door-describe',
    nodes: [agent, validate],
    edges: [[DESCRIBE_NODES.describe, DESCRIBE_NODES.validate]],
    nodeTimeout: DESCRIBE_TIMEOUT_MS,
    timeout: DESCRIBE_TIMEOUT_MS + 500,
  });

  const elapsedMs = () => Date.now() - started;
  try {
    const run = await graph.invoke([
      new ImageBlock({ format: options.format ?? 'jpeg', source: { bytes: frame } }),
      new TextBlock('Describe this frame under the rules.'),
    ]);
    const failed = run.results.find((r) => r.status !== Status.COMPLETED);
    if (failed || !judged) {
      return { result: { candidate: null, reason: `model: ${failed?.error?.message ?? 'no answer'}`, elapsedMs: elapsedMs() }, path: pathOf(run) };
    }
    return { result: { ...judged, elapsedMs: elapsedMs() }, path: pathOf(run) };
  } catch (err) {
    return { result: { candidate: null, reason: `model: ${err instanceof Error ? err.message : String(err)}`, elapsedMs: elapsedMs() }, path: [] };
  }
}
