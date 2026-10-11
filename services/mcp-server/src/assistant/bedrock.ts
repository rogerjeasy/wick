/**
 * The real model behind brain.ts: Amazon Bedrock's Converse API.
 *
 * Converse is used, not a model's own API, so the model is a setting
 * (`WICK_ASSISTANT_MODEL_ID`): the request, the tool list and the reply
 * have one shape whichever model answers.
 */
import { ConverseCommand, type BedrockRuntimeClient, type ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import type { Converse, ToolCall } from './brain.js';

/** The model the Narrator already writes with (services/agent/src/agents/narrator/prose.ts). */
export const DEFAULT_ASSISTANT_MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

/** Two spoken sentences, or a handful of tool calls. */
const MAX_TOKENS = 500;
/** A step that takes longer than this is a failed step: someone is waiting for an answer. */
const STEP_TIMEOUT_MS = 20_000;

export function createBedrockConverse(client: Pick<BedrockRuntimeClient, 'send'>, modelId: string = DEFAULT_ASSISTANT_MODEL_ID): Converse {
  return async ({ system, messages, tools }) => {
    const input = {
      modelId,
      system: [{ text: system }],
      messages,
      toolConfig: {
        tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema } } })),
      },
      inferenceConfig: { maxTokens: MAX_TOKENS, temperature: 0.2 },
    } as unknown as ConverseCommandInput;

    const out = await client.send(new ConverseCommand(input), { abortSignal: AbortSignal.timeout(STEP_TIMEOUT_MS) });

    const blocks = out.output?.message?.content ?? [];
    const calls: ToolCall[] = blocks.flatMap((b) =>
      b.toolUse?.toolUseId && b.toolUse.name
        ? [{ id: b.toolUse.toolUseId, name: b.toolUse.name, args: (b.toolUse.input ?? {}) as Record<string, unknown> }]
        : [],
    );
    return { text: blocks.map((b) => b.text ?? '').join('').trim(), calls };
  };
}
