import { describe, expect, it } from 'vitest';
import { agentCoreAssistant, ASSISTANT_RUNTIME_TIMEOUT_MS, type AssistantRuntimeSend } from '../runtime.js';
import type { AgentTurnPayload } from '../turn.js';

const PAYLOAD: AgentTurnPayload = {
  kind: 'assistant.turn',
  householdId: 'hh_1',
  memberId: 'usr-2',
  memberToken: 'the-token',
  who: { memberName: 'Sarah', residentName: 'Margaret', householdName: 'Mum’s', simulated: false },
  timeZone: 'Europe/London',
  question: 'Hello',
};
const SESSION = 'assistant-0123456789abcdef0123456789abcdef';

const replying = (body: string, statusCode = 200) => {
  const sent: Parameters<AssistantRuntimeSend>[0][] = [];
  const send: AssistantRuntimeSend = async (input) => {
    sent.push(input);
    return { statusCode, response: { transformToString: async () => body } };
  };
  return { sent, send };
};

describe('agentCoreAssistant — InvokeAgentRuntime for one member’s turn', () => {
  it('invokes the runtime in the member’s own session, with the turn as JSON', async () => {
    const { sent, send } = replying('{"say":"Hello."}');

    const out = await agentCoreAssistant({ send, runtimeArn: 'arn:runtime' }).invoke(SESSION, PAYLOAD);

    expect(out).toEqual({ say: 'Hello.' });
    expect(sent[0]).toMatchObject({ agentRuntimeArn: 'arn:runtime', runtimeSessionId: SESSION, contentType: 'application/json', accept: 'application/json' });
    expect(JSON.parse(new TextDecoder().decode(sent[0]!.payload))).toEqual(PAYLOAD);
  });

  it('adds the runtime version to the session, so a deploy reaches the member at their next question', async () => {
    const { sent, send } = replying('{}');

    await agentCoreAssistant({ send, runtimeArn: 'arn:runtime', version: '7' }).invoke(SESSION, PAYLOAD);

    expect(sent[0]!.runtimeSessionId).toBe(`${SESSION}-v7`);
  });

  it('fails on a status that is not success', async () => {
    await expect(agentCoreAssistant({ send: replying('{}', 500).send, runtimeArn: 'arn:runtime' }).invoke(SESSION, PAYLOAD)).rejects.toThrow('agentcore_500');
  });

  it('gives up at its deadline, longer than the agent’s own twenty seconds', async () => {
    const never: AssistantRuntimeSend = () => new Promise(() => undefined);

    await expect(agentCoreAssistant({ send: never, runtimeArn: 'arn:runtime', timeoutMs: 20 }).invoke(SESSION, PAYLOAD)).rejects.toThrow('agentcore_timeout');
    expect(ASSISTANT_RUNTIME_TIMEOUT_MS).toBeGreaterThan(20_000);
    expect(ASSISTANT_RUNTIME_TIMEOUT_MS).toBeLessThan(30_000);
  });
});
