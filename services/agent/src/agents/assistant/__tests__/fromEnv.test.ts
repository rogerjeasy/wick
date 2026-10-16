import { describe, expect, it } from 'vitest';
import { BedrockModel, type SnapshotStorage } from '@strands-agents/sdk';
import { assistantDepsFromEnv, DEFAULT_ASSISTANT_MODEL_ID } from '../fromEnv.js';
import { inMemorySnapshotStorage } from '../sessions.js';

const configOf = (deps: ReturnType<typeof assistantDepsFromEnv>) => (deps!.model as BedrockModel).getConfig();

const ENV = {
  WICK_MCP_URL: 'https://wick.example/mcp',
  ASSISTANT_MODEL_ID: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  AGENTS_GUARDRAIL_ID: 'gr-abc123',
  AGENTS_GUARDRAIL_VERSION: '1',
  AGENTCORE_MEMORY_ID: 'wick_assistant-abcdefghij',
  AWS_REGION: 'us-east-1',
};

describe('assistantDepsFromEnv — the deployment names the server, the model, the guardrail and the memory', () => {
  it('is nothing without Wick’s MCP address: there is nobody to ask', () => {
    expect(assistantDepsFromEnv({ ...ENV, WICK_MCP_URL: '' })).toBeUndefined();
    expect(assistantDepsFromEnv({ ...ENV, WICK_MCP_URL: undefined })).toBeUndefined();
  });

  it('asks Claude Sonnet 4.5 on Bedrock, with the Bedrock Guardrail on what the member asks and what it answers', () => {
    const deps = assistantDepsFromEnv(ENV)!;

    expect(deps.model).toBeInstanceOf(BedrockModel);
    expect(deps.model.getConfig()).toMatchObject({
      modelId: ENV.ASSISTANT_MODEL_ID,
      guardrailConfig: { guardrailIdentifier: 'gr-abc123', guardrailVersion: '1', guardLatestUserMessage: true },
    });
    expect(deps.mcpUrl).toBe('https://wick.example/mcp');
  });

  it('asks the stand-in’s own model when none is named', () => {
    expect(assistantDepsFromEnv({ ...ENV, ASSISTANT_MODEL_ID: undefined })!.model.getConfig().modelId).toBe(DEFAULT_ASSISTANT_MODEL_ID);
    expect(DEFAULT_ASSISTANT_MODEL_ID).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
  });

  it('has no guardrail config where the deployment named none, rather than a broken one', () => {
    expect(configOf(assistantDepsFromEnv({ ...ENV, AGENTS_GUARDRAIL_ID: undefined })).guardrailConfig).toBeUndefined();
    expect(configOf(assistantDepsFromEnv({ ...ENV, AGENTS_GUARDRAIL_VERSION: '' })).guardrailConfig).toBeUndefined();
  });

  it('remembers each member’s words in AgentCore Memory where a memory is named, and nothing where none is', () => {
    expect(assistantDepsFromEnv(ENV)!.memoryFor!('hh_1', 'usr-2')).toBeDefined();
    expect(assistantDepsFromEnv({ ...ENV, AGENTCORE_MEMORY_ID: undefined })!.memoryFor).toBeUndefined();
  });

  it('keeps conversations in the AgentCore Memory session storage it is handed, and in the process without one', () => {
    const durable: SnapshotStorage = inMemorySnapshotStorage();

    expect(assistantDepsFromEnv(ENV, () => durable)!.sessions.snapshot).toBe(durable);
    expect(assistantDepsFromEnv(ENV)!.sessions.snapshot).not.toBe(durable);
  });
});
