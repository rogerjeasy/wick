import { describe, expect, it, vi } from 'vitest';
import type { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { DEFAULT_ASSISTANT_MODEL_ID, createBedrockConverse } from '../bedrock.js';

const client = (output: unknown) => {
  const send = vi.fn(async (_command: ConverseCommand) => ({ output }));
  return { send, client: { send } as unknown as Pick<BedrockRuntimeClient, 'send'> };
};

const REQUEST = {
  system: 'You are Wick.',
  messages: [{ role: 'user' as const, content: [{ text: 'How has the week been?' }] }],
  tools: [{ name: 'get_week_narrative', description: 'The week.', inputSchema: { type: 'object', properties: {} } }],
};

describe('createBedrockConverse', () => {
  it('sends the instructions, the conversation and the tools in Converse’s own shape', async () => {
    const { send, client: bedrock } = client({ message: { content: [{ text: 'A quiet week.' }] } });

    await createBedrockConverse(bedrock)(REQUEST);

    expect(send.mock.calls[0]![0].input).toMatchObject({
      modelId: DEFAULT_ASSISTANT_MODEL_ID,
      system: [{ text: 'You are Wick.' }],
      messages: REQUEST.messages,
      toolConfig: { tools: [{ toolSpec: { name: 'get_week_narrative', description: 'The week.', inputSchema: { json: { type: 'object', properties: {} } } } }] },
    });
  });

  it('reads back the sentence', async () => {
    const { client: bedrock } = client({ message: { content: [{ text: ' A quiet week. ' }] } });

    expect(await createBedrockConverse(bedrock)(REQUEST)).toEqual({ text: 'A quiet week.', calls: [] });
  });

  it('reads back the tools the model wants called, with what it said beside them', async () => {
    const { client: bedrock } = client({
      message: { content: [{ text: 'Let me look.' }, { toolUse: { toolUseId: 't1', name: 'get_week_narrative', input: { isoWeek: '2026-W41' } } }] },
    });

    expect(await createBedrockConverse(bedrock, 'some-model')(REQUEST)).toEqual({
      text: 'Let me look.',
      calls: [{ id: 't1', name: 'get_week_narrative', args: { isoWeek: '2026-W41' } }],
    });
  });

  it('answers with nothing, rather than throwing, when the model returns no message', async () => {
    const { client: bedrock } = client(undefined);

    expect(await createBedrockConverse(bedrock)(REQUEST)).toEqual({ text: '', calls: [] });
  });
});
