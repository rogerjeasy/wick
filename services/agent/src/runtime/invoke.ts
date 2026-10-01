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

export type RuntimeSend = (input: InvokeAgentRuntimeCommandInput & { payload: Uint8Array }) => Promise<RuntimeReply>;

export interface RuntimeTarget {
  readonly send: RuntimeSend;
  readonly runtimeArn: string;
  /** The deployed runtime version (infra: agent_runtime_version). */
  readonly version?: string;
}

export async function invokeRuntime(
  target: RuntimeTarget,
  kind: string,
  householdId: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const out = await target.send({
    agentRuntimeArn: target.runtimeArn,
    runtimeSessionId: householdSessionId(householdId, target.version),
    contentType: 'application/json',
    accept: 'application/json',
    payload: new TextEncoder().encode(JSON.stringify({ kind, householdId, ...payload })),
  });

  const status = out.statusCode ?? 200;
  if (status < 200 || status >= 300) throw new Error(`agentcore_${status}`);

  const text = (await out.response?.transformToString()) ?? '';
  return text ? JSON.parse(text) : {};
}

/** The real target, for a Lambda shim. AGENT_RUNTIME_ARN and _VERSION come from infra/agentcore.tf. */
export function agentCoreTarget(
  runtimeArn = process.env.AGENT_RUNTIME_ARN ?? '',
  version = process.env.AGENT_RUNTIME_VERSION ?? '',
): RuntimeTarget {
  if (!runtimeArn) throw new Error('AGENT_RUNTIME_ARN not set');
  const client = new BedrockAgentCoreClient({});
  return {
    runtimeArn,
    ...(version ? { version } : {}),
    send: (input) => client.send(new InvokeAgentRuntimeCommand(input)),
  };
}
