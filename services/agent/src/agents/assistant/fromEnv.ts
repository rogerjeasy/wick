/**
 * The assistant's parts, as the deployment names them (infra/agentcore.tf):
 *
 *   WICK_MCP_URL              Wick's MCP endpoint, and its GET /api/me, where
 *                             each token is checked. Unset, there is no turn.
 *   ASSISTANT_MODEL_ID        the model (the stand-in's own Sonnet 4.5 unless set)
 *   AGENTS_GUARDRAIL_ID       the Bedrock Guardrail (infra/guardrail.tf) and its
 *   AGENTS_GUARDRAIL_VERSION  published version: both, or no guardrail config
 *   AGENTCORE_MEMORY_ID       the AgentCore Memory (infra/assistant.tf): the
 *                             members' own words, and — through the session
 *                             storage the entrypoint hands in — conversations
 *
 * Read when a turn arrives, not when the container starts: a runtime that
 * serves the door and the live view must not fail to start for want of the
 * assistant's settings.
 */
import { ApplyGuardrailCommand, BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { guardReplyWith } from './guard.js';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { BedrockModel } from '@strands-agents/sdk';
import { memberMemoryStore } from './memory.js';
import { sessionStorageFor, type AgentCoreSessionStorageFactory } from './sessions.js';
import type { AssistantTurnDeps } from './turn.js';
import { verifyWithWick } from './verify.js';

/** The model the stand-in assistant asks (services/mcp-server/src/assistant/bedrock.ts) and the Narrator writes with. */
export const DEFAULT_ASSISTANT_MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

/** Two spoken sentences, or a handful of tool calls — the stand-in's own budget. */
const MAX_TOKENS = 500;

type Env = Readonly<Record<string, string | undefined>>;

export function assistantDepsFromEnv(env: Env, agentCoreSessions?: AgentCoreSessionStorageFactory): AssistantTurnDeps | undefined {
  const mcpUrl = env.WICK_MCP_URL;
  if (!mcpUrl) return undefined;

  const guardrailIdentifier = env.AGENTS_GUARDRAIL_ID;
  const guardrailVersion = env.AGENTS_GUARDRAIL_VERSION;
  const model = new BedrockModel({
    modelId: env.ASSISTANT_MODEL_ID || DEFAULT_ASSISTANT_MODEL_ID,
    ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
    maxTokens: MAX_TOKENS,
    temperature: 0.2,
    // No guardrail on the model: it would read the member's question, and
    // "How has my mum been?" is what Wick is for. The reply is guarded
    // instead (guard.ts), grounded in what the tools returned.
  });
  const guardrails = new BedrockRuntimeClient(env.AWS_REGION ? { region: env.AWS_REGION } : {});

  const memoryId = env.AGENTCORE_MEMORY_ID;
  const client = memoryId ? new BedrockAgentCoreClient(env.AWS_REGION ? { region: env.AWS_REGION } : {}) : undefined;

  return {
    model,
    mcpUrl,
    // Whose a token is, asked of the same Wick server: the payload's ids are only a claim.
    verifyMember: verifyWithWick(mcpUrl),
    sessions: sessionStorageFor(env, agentCoreSessions),
    now: Date.now,
    ...(guardrailIdentifier && guardrailVersion
      ? { guardReply: guardReplyWith((input) => guardrails.send(new ApplyGuardrailCommand(input)), { id: guardrailIdentifier, version: guardrailVersion }) }
      : {}),
    ...(env.WICK_HOUSEHOLD_TZ ? { timeZone: env.WICK_HOUSEHOLD_TZ } : {}),
    ...(memoryId && client ? { memoryFor: (householdId: string, memberId: string) => memberMemoryStore({ memoryId, householdId, memberId, client }) } : {}),
  };
}
