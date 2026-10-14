/**
 * Calling the agent plane. EventBridge, Scheduler and API Gateway cannot
 * target an AgentCore Runtime directly, so thin Lambdas do — through this.
 *
 * Session = household. AgentCore gives every runtime session its own
 * microVM; making the household the session makes the product's trust
 * boundary the platform's isolation boundary, and keeps a household's
 * door graph, chime press and live view in one warm microVM.
 */
import { createHash } from 'node:crypto';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  type InvokeAgentRuntimeCommandInput,
} from '@aws-sdk/client-bedrock-agentcore';

/**
 * AgentCore requires a runtimeSessionId of at least 33 characters.
 *
 * The runtime version is part of it: a session's microVM keeps the image it
 * started with for up to 8 hours, so without it a deploy would not reach a
 * household until its session ended. A new version means a fresh microVM;
 * the old one idles out on its own.
 */
export function householdSessionId(householdId: string, runtimeVersion?: string): string {
  const safe = householdId.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 64);
  const digest = createHash('sha256').update(householdId).digest('hex').slice(0, 16);
  const version = runtimeVersion ? `-v${runtimeVersion.replace(/[^A-Za-z0-9]/g, '')}` : '';
  return `wick-household-${safe}-${digest}${version}`;
}

export interface RuntimeReply {
  readonly statusCode?: number | undefined;
  readonly response?: { transformToString(): Promise<string> } | undefined;
}

export type RuntimeSend = (
  input: InvokeAgentRuntimeCommandInput & { payload: Uint8Array },
  options?: { readonly abortSignal?: AbortSignal },
) => Promise<RuntimeReply>;

/**
 * How long one call to the agent plane may take, answer and body together,
 * unless the target says otherwise. A cold session takes a few seconds and a
 * graph's own ceiling is 12 (graphs/doorAction.ts); twenty is past both and
 * inside the 25-second live Lambda and the 30-second card-action one
 * (infra/live.tf, card-action.tf). Without it, a runtime that never answers
 * holds the Lambda until Lambda kills it, and the log says only "timed out".
 */
export const RUNTIME_TIMEOUT_MS = 20_000;

export interface RuntimeTarget {
  readonly send: RuntimeSend;
  readonly runtimeArn: string;
  /** The deployed runtime version (infra: agent_runtime_version). */
  readonly version?: string;
  /** This caller's deadline for one call (RUNTIME_TIMEOUT_MS unless given). Must sit below the calling Lambda's timeout. */
  readonly timeoutMs?: number;
}

/** Rejects with `agentcore_timeout` the moment `signal` is aborted, whatever `work` is doing. */
function beforeDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const giveUp = () => reject(new Error('agentcore_timeout'));
    if (signal.aborted) return giveUp();
    signal.addEventListener('abort', giveUp, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', giveUp));
  });
}

export async function invokeRuntime(
  target: RuntimeTarget,
  kind: string,
  householdId: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  // One deadline for the call and the reading of its answer: the SDK's
  // abortSignal ends the request, and the race ends the wait even where a
  // streamed body would not notice the signal.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs ?? RUNTIME_TIMEOUT_MS);
  try {
    const out = await beforeDeadline(target.send({
      agentRuntimeArn: target.runtimeArn,
      runtimeSessionId: householdSessionId(householdId, target.version),
      contentType: 'application/json',
      accept: 'application/json',
      payload: new TextEncoder().encode(JSON.stringify({ kind, householdId, ...payload })),
    }, { abortSignal: controller.signal }), controller.signal);

    const status = out.statusCode ?? 200;
    if (status < 200 || status >= 300) throw new Error(`agentcore_${status}`);

    const text = (await beforeDeadline(out.response?.transformToString() ?? Promise.resolve(''), controller.signal)) ?? '';
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

/** The real target, for a Lambda shim. AGENT_RUNTIME_ARN and _VERSION come from infra/agentcore.tf. */
export function agentCoreTarget(
  runtimeArn = process.env.AGENT_RUNTIME_ARN ?? '',
  version = process.env.AGENT_RUNTIME_VERSION ?? '',
  timeoutMs?: number,
): RuntimeTarget {
  if (!runtimeArn) throw new Error('AGENT_RUNTIME_ARN not set');
  const client = new BedrockAgentCoreClient({});
  return {
    runtimeArn,
    ...(version ? { version } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    send: (input, options) => client.send(new InvokeAgentRuntimeCommand(input), options),
  };
}
