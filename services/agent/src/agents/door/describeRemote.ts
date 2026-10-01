/**
 * Phase 2b through the agent plane: the frame goes to the household's
 * AgentCore Runtime session, where the Strands describe graph
 * (graphs/doorDescribe.ts) runs the vision agent and the validator.
 *
 * Same contract as describeFrame: never throws. Whatever goes wrong, the
 * resident keeps the Phase 1 card, which is still useful (§9.1).
 */
import type { DescribeResult } from './describe.js';

type Invoke = (kind: string, householdId: string, payload: Record<string, unknown>) => Promise<unknown>;

const isDescribeResult = (v: unknown): v is DescribeResult =>
  typeof v === 'object' && v !== null && 'candidate' in v && typeof (v as { reason?: unknown }).reason === 'string';

export function describeViaRuntime(invoke: Invoke, householdId: string): (bytes: Uint8Array) => Promise<DescribeResult> {
  return async (bytes) => {
    const started = Date.now();
    try {
      const out = await invoke('door.describe', householdId, { frame: Buffer.from(bytes).toString('base64'), format: 'jpeg' });
      return isDescribeResult(out) ? out : { candidate: null, reason: 'agentcore: malformed answer', elapsedMs: Date.now() - started };
    } catch (err) {
      return { candidate: null, reason: `agentcore: ${err instanceof Error ? err.message : String(err)}`, elapsedMs: Date.now() - started };
    }
  };
}
