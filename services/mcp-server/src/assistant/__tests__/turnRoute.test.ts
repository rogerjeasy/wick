import { afterEach, describe, expect, it, vi } from 'vitest';
import { assistantSessionId } from '@wick/agent';
import { linkNewOrganiser, startServer, type Harness } from '../../__tests__/harness.js';
import type { AppDeps } from '../../server.js';
import { STEPS_PER_PERSON } from '../router.js';
import { TURN_COST, type AgentTurnPayload, type InvokeAgentTurn } from '../turn.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function server(overrides: Partial<AppDeps>): Promise<Harness> {
  const h = await startServer(overrides);
  closers.push(h.close);
  return h;
}

const post = (h: Harness, token: string | undefined, body: unknown) =>
  fetch(`${h.base}/assistant/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

async function allowedSarah(h: Harness) {
  const sarah = await linkNewOrganiser(h);
  await h.store.setMemberStatus(sarah.householdId, sarah.userId, 'allowed', Date.now());
  return sarah;
}

/** The runtime, as far as the route can tell: what it was sent, and a fixed answer. */
function runtime(answer: unknown | ((payload: AgentTurnPayload) => unknown)) {
  const sent: { sessionId: string; payload: AgentTurnPayload }[] = [];
  const invoke = vi.fn<InvokeAgentTurn>(async (sessionId, payload) => {
    sent.push({ sessionId, payload });
    return typeof answer === 'function' ? (answer as (p: AgentTurnPayload) => unknown)(payload) : answer;
  });
  return { sent, invoke, agent: { invoke } };
}

const READ = { trace: [{ tool: 'get_today', ok: true, args: { day: 'today' } }], toolTexts: ['{"dayInWords":"today","doorbell":6}'] };

describe('POST /assistant/turn — the assistant as an agent on AgentCore', () => {
  it('is for a signed-in person only', async () => {
    const r = runtime({ say: 'Hello.', trace: [], toolTexts: [] });
    const h = await server({ assistantAgent: r.agent });

    expect((await post(h, undefined, { question: 'Hello' })).status).toBe(401);
    expect(r.invoke).not.toHaveBeenCalled();
  });

  it('is unavailable where no runtime is configured, so the app falls back to /assistant/next', async () => {
    const h = await server({});
    const sarah = await allowedSarah(h);

    const res = await post(h, sarah.tokens.access_token, { question: 'Hello' });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'assistant_unavailable' });
  });

  it('sends the member’s own token, and the home, the member and the names from the account — never from the request', async () => {
    const r = runtime({ say: 'Hello Sarah.', trace: [], toolTexts: [] });
    const h = await server({ assistantAgent: r.agent });
    const sarah = await allowedSarah(h);

    await post(h, sarah.tokens.access_token, { question: '  Hello  ', householdId: 'hh_someone_else', memberId: 'usr-tom', who: { residentName: 'Nobody' } });

    expect(r.sent).toHaveLength(1);
    const { sessionId, payload } = r.sent[0]!;
    expect(sessionId).toBe(assistantSessionId(sarah.householdId, sarah.userId));
    expect(sessionId.length).toBeGreaterThanOrEqual(33);
    expect(payload).toEqual({
      kind: 'assistant.turn',
      householdId: sarah.householdId,
      memberId: sarah.userId,
      memberToken: sarah.tokens.access_token,
      who: { memberName: 'Sarah', residentName: 'Margaret', householdName: expect.any(String), simulated: false },
      timeZone: expect.any(String),
      question: 'Hello',
    });
  });

  it('carries the member’s answer to what was waiting, and nothing else', async () => {
    const r = runtime({ say: 'Sent.', trace: [], toolTexts: [] });
    const h = await server({ assistantAgent: r.agent });
    const sarah = await allowedSarah(h);

    await post(h, sarah.tokens.access_token, { resume: { approved: { 'hook:beforeToolCall:t1:approve': true } } });
    await post(h, sarah.tokens.access_token, { resume: { approved: false } });

    expect(r.sent.map((s) => s.payload.resume)).toEqual([{ approved: { 'hook:beforeToolCall:t1:approve': true } }, { approved: false }]);
    expect(r.sent.every((s) => s.payload.question === undefined)).toBe(true);
  });

  it('refuses what is not a question or an answer, without asking the runtime', async () => {
    const r = runtime({ say: 'x', trace: [], toolTexts: [] });
    const h = await server({ assistantAgent: r.agent });
    const sarah = await allowedSarah(h);

    for (const body of [{}, { question: '' }, { question: 'a', resume: { approved: true } }, { resume: { approved: 'yes' } }, { resume: { approved: { a: 'yes' } } }]) {
      expect((await post(h, sarah.tokens.access_token, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(r.invoke).not.toHaveBeenCalled();
  });

  it('INV-9: answers someone the resident has not allowed in the tools’ own words, and never invokes the agent', async () => {
    const r = runtime({ say: 'Hello.', trace: [], toolTexts: [] });
    const h = await server({ assistantAgent: r.agent });
    const waiting = await linkNewOrganiser(h);

    const res = await post(h, waiting.tokens.access_token, { question: 'Hello' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { say: string; trace: unknown[] };
    expect(body.say).toContain('hasn’t allowed this yet');
    expect(body.trace).toEqual([]);
    expect(r.invoke).not.toHaveBeenCalled();
  });

  it('says what the agent said when every number in it came from a tool or the question', async () => {
    const h = await server({ assistantAgent: runtime({ say: 'The doorbell went 6 times today.', ...READ, asked: 'Did anyone come today?' }).agent });
    const sarah = await allowedSarah(h);

    const body = await (await post(h, sarah.tokens.access_token, { question: 'Did anyone come today?' })).json();

    expect(body).toEqual({ say: 'The doorbell went 6 times today.', ...READ });
  });

  it('says the tools’ own sentences instead when the agent adds a number, or says what the Guardian refuses', async () => {
    // The number check lets through numbers from the date and time (brain.ts checkReply), so the
    // clock is fixed where no part of it is 9: unfixed, this failed from 9 to 10 o'clock in London.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 15, 13, 20)); // Thursday 15 October 2026, 14:20 in London
    try {
      const invented = await server({ assistantAgent: runtime({ say: 'The doorbell went 9 times.', ...READ }).agent });
      const sarah = await allowedSarah(invented);
      expect(await (await post(invented, sarah.tokens.access_token, { question: 'Who came?' })).json()).toEqual({ unsupported: true, ...READ });
    } finally {
      vi.useRealTimers();
    }

    const health = await server({ assistantAgent: runtime({ say: 'She seems depressed and should see her doctor about her medication.', ...READ }).agent });
    const tom = await allowedSarah(health);
    expect(await (await post(health, tom.tokens.access_token, { question: 'How is she?' })).json()).toMatchObject({ unsupported: true });
  });

  it('lets a number from the member’s own question be said back', async () => {
    const h = await server({ assistantAgent: runtime({ say: 'I will tell her about 4pm.', trace: [], toolTexts: [], asked: 'Tell her I come at 4pm' }).agent });
    const sarah = await allowedSarah(h);

    expect(await (await post(h, sarah.tokens.access_token, { resume: { approved: true } })).json()).toMatchObject({ say: 'I will tell her about 4pm.' });
  });

  it('shows what waits for a yes under the server’s own titles, as the plan', async () => {
    const waiting = {
      needsApproval: [{ id: 'hook:beforeToolCall:t1:approve', name: 'send_note_to_tv', args: { message: 'Hi Mum' }, title: 'whatever the runtime said' }],
      plan: ['whatever'],
      trace: [],
      toolTexts: [],
    };
    const h = await server({ assistantAgent: runtime(waiting).agent });
    const sarah = await allowedSarah(h);

    expect(await (await post(h, sarah.tokens.access_token, { question: 'Tell Mum hi' })).json()).toEqual({
      needsApproval: [{ id: 'hook:beforeToolCall:t1:approve', name: 'send_note_to_tv', args: { message: 'Hi Mum' }, title: 'Send a note to the television' }],
      plan: ['Send a note to the television'],
      trace: [],
      toolTexts: [],
    });
  });

  it('is unavailable, without the reason or the token in the log, when the runtime fails or refuses', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const failing = await server({ assistantAgent: { invoke: async () => { throw new Error('AccessDeniedException: arn:aws:bedrock-agentcore:secret'); } } });
    const sarah = await allowedSarah(failing);

    const res = await post(failing, sarah.tokens.access_token, { question: 'Hello' });
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('arn:aws');

    for (const answer of [{ error: 'unauthorized' }, { error: 'not_configured' }, 'nonsense', { say: 42 }, { needsApproval: [{ name: 'rm_rf', args: {} }], trace: [], toolTexts: [] }]) {
      const h = await server({ assistantAgent: runtime(answer).agent });
      const tom = await allowedSarah(h);
      expect((await post(h, tom.tokens.access_token, { question: 'Hello' })).status, JSON.stringify(answer)).toBe(503);
    }
    expect(lines.join('\n')).not.toContain(sarah.tokens.access_token);
    expect(lines.join('\n')).not.toContain('arn:aws');
  });

  it('counts a turn as several steps of the assistant’s allowance', async () => {
    const h = await server({ assistantAgent: runtime({ say: 'Yes.', trace: [], toolTexts: [] }).agent });
    const sarah = await allowedSarah(h);

    for (let i = 0; i < Math.floor(STEPS_PER_PERSON / TURN_COST); i += 1) expect((await post(h, sarah.tokens.access_token, { question: 'Hi' })).status).toBe(200);
    const res = await post(h, sarah.tokens.access_token, { question: 'Hi' });

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'assistant_busy' });
  });
});
