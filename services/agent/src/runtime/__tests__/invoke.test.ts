import { describe, it, expect, vi } from 'vitest';
import { householdSessionId, invokeRuntime, type RuntimeSend } from '../invoke.js';

const ARN = 'arn:aws:bedrock-agentcore:us-east-1:707938860881:runtime/wick_agents-abc';

const reply = (body: unknown, statusCode = 200) => ({
  statusCode,
  response: { transformToString: async () => JSON.stringify(body) },
});

describe('householdSessionId — session = household', () => {
  it('is stable for a household, so every graph it runs lands in the same microVM', () => {
    expect(householdSessionId('margaret')).toBe(householdSessionId('margaret'));
  });

  it('meets AgentCore\'s 33-character minimum even for a short household id', () => {
    expect(householdSessionId('m').length).toBeGreaterThanOrEqual(33);
  });

  it('keeps two households apart even when their ids sanitise the same', () => {
    expect(householdSessionId('a/b')).not.toBe(householdSessionId('a.b'));
    expect(householdSessionId('a/b')).toMatch(/^[A-Za-z0-9-]+$/);
  });
});

describe('householdSessionId — a deploy reaches every household at once', () => {
  it('moves a household to a fresh session when the runtime version changes, so no one stays on the code before a deploy', () => {
    // Seen live: margaret's warm microVM kept running the previous image for
    // the rest of its 8h lifetime after the runtime was updated.
    expect(householdSessionId('margaret', '6')).not.toBe(householdSessionId('margaret', '5'));
    expect(householdSessionId('margaret', '6')).toBe(householdSessionId('margaret', '6'));
    expect(householdSessionId('margaret', '6')).toMatch(/^[A-Za-z0-9-]+$/);
  });
});

describe('invokeRuntime', () => {
  it('uses the target\'s runtime version in the session', async () => {
    const send = vi.fn<RuntimeSend>(async () => reply({}));
    await invokeRuntime({ send, runtimeArn: ARN, version: '5' }, 'live.start', 'margaret', {});
    expect(send.mock.calls[0]![0].runtimeSessionId).toBe(householdSessionId('margaret', '5'));
  });

  it('sends the kind and payload as JSON to the runtime, on the household session', async () => {
    const send = vi.fn<RuntimeSend>(async () => reply({ result: 'rang' }));

    const out = await invokeRuntime({ send, runtimeArn: ARN }, 'door.action', 'margaret', { cardId: 'door-abc' });

    expect(out).toEqual({ result: 'rang' });
    const input = send.mock.calls[0]![0];
    expect(input.agentRuntimeArn).toBe(ARN);
    expect(input.runtimeSessionId).toBe(householdSessionId('margaret'));
    expect(input.contentType).toBe('application/json');
    expect(JSON.parse(new TextDecoder().decode(input.payload))).toEqual({ kind: 'door.action', householdId: 'margaret', cardId: 'door-abc' });
  });

  it('throws on a non-2xx answer instead of handing back an error body as a result', async () => {
    const send = vi.fn<RuntimeSend>(async () => reply({ error: 'internal' }, 500));
    await expect(invokeRuntime({ send, runtimeArn: ARN }, 'door.action', 'margaret', {})).rejects.toThrow('agentcore_500');
  });
});
