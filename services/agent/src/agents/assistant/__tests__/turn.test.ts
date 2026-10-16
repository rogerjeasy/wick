import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryStore, MessageData, SnapshotStorage } from '@strands-agents/sdk';
import { assistantSessionId } from '../identity.js';
import { inMemorySnapshotStorage } from '../sessions.js';
import {
  DECLINED_TEXT,
  NOTHING_WAITING_TEXT,
  TOO_MANY_STEPS_TEXT,
  TOO_SLOW_TEXT,
  assistantTurnHandler,
  readTurnRequest,
  runAssistantTurn,
  type AssistantTurnDeps,
  type AssistantTurnOutput,
  type AssistantTurnRequest,
} from '../turn.js';
import { ScriptedToolModel, type Step } from './scriptedToolModel.js';
import { startWickMcp, type WickMcp } from './wickMcpServer.js';

const TOKEN = 'member-token-6f1c9e0a-secret';
const HH = 'hh_test1';
const MEMBER = 'usr-sarah';
const WHO = { memberName: 'Sarah', residentName: 'Margaret', householdName: 'Mum’s house', simulated: false };
// Tuesday 13 October 2026, 12:00 UTC.
const NOW = Date.UTC(2026, 9, 13, 12);

let mcp: WickMcp;
let storage: SnapshotStorage;
const logged: string[] = [];

beforeEach(async () => {
  mcp = await startWickMcp(TOKEN);
  storage = inMemorySnapshotStorage();
  logged.length = 0;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  await mcp.close();
});

const ask = (question: string): AssistantTurnRequest => ({ householdId: HH, memberId: MEMBER, memberToken: TOKEN, who: WHO, timeZone: 'Europe/London', question });
const answer = (approved: AssistantTurnRequest['resume'] extends infer R ? (R extends { approved: infer A } ? A : never) : never): AssistantTurnRequest => ({
  householdId: HH, memberId: MEMBER, memberToken: TOKEN, who: WHO, timeZone: 'Europe/London', resume: { approved },
});

function deps(model: ScriptedToolModel, more: Partial<AssistantTurnDeps> = {}): AssistantTurnDeps {
  return { model, mcpUrl: mcp.url, sessions: { snapshot: storage }, now: () => NOW, ...more };
}

/** One question to a fresh agent, as each invocation of the runtime is. */
const turn = (request: AssistantTurnRequest, script: Step[], more: Partial<AssistantTurnDeps> = {}) => {
  const model = new ScriptedToolModel(script);
  return { model, out: runAssistantTurn(request, deps(model, more)) };
};

const savedSession = async (): Promise<string> =>
  JSON.stringify(await storage.loadSnapshot({ location: { sessionId: assistantSessionId(HH, MEMBER), scope: 'agent', scopeId: 'wick-assistant' } }));

describe('a question the tools can answer by reading', () => {
  it('runs read-only tools without asking, and says what they returned', async () => {
    const { out } = turn(ask('Did anyone come today?'), [
      { call: [{ name: 'get_today', input: { day: 'today' } }] },
      { say: 'The doorbell went 6 times today.' },
    ]);

    const result = await out;

    expect(result.say).toBe('The doorbell went 6 times today.');
    expect(result.needsApproval).toBeUndefined();
    expect(result.trace).toEqual([{ tool: 'get_today', ok: true, args: { day: 'today' } }]);
    expect(result.toolTexts).toEqual(['{"dayInWords":"today","doorbell":6,"films":2}']);
    expect(result.asked).toBe('Did anyone come today?');
    expect(mcp.calls).toEqual([{ name: 'get_today', args: { day: 'today' } }]);
  });

  it('calls Wick’s tools over MCP with the member’s own token, on every request', async () => {
    const { model, out } = turn(ask('Did anyone come today?'), [{ call: [{ name: 'get_today' }] }, { say: 'Six.' }]);

    await out;

    expect(mcp.authorizations.length).toBeGreaterThan(0);
    expect(mcp.authorizations.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
    // The tool list is the server's own.
    expect(model.seen[0]!.tools.sort()).toEqual(['arrange_visit', 'expect_visit', 'get_today', 'send_note_to_tv']);
  });

  it('tells the model the rules, the names on the account and the day at the house', async () => {
    const { model, out } = turn(ask('Hello'), [{ say: 'Hello Sarah.' }]);

    await out;

    expect(model.seen[0]!.system).toContain('You know nothing about the house except what Wick\'s tools return');
    expect(model.seen[0]!.system).toContain('Margaret');
    expect(model.seen[0]!.system).toContain('Tuesday 13 October 2026');
    expect(model.seen[0]!.system).toContain('call arrange_visit and send_note_to_tv');
  });
});

describe('a write waits for the member’s yes (Strands interrupts)', () => {
  it('stops before a write, and says what it would do with exactly what', async () => {
    const { model, out } = turn(ask('Tell Mum I’ll ring at six'), [
      { call: [{ name: 'send_note_to_tv', input: { message: 'I’ll ring at six. Sarah' } }] },
      { say: 'Done.' },
    ]);

    const result = await out;

    expect(result.say).toBeUndefined();
    expect(result.needsApproval).toEqual([
      { id: expect.any(String), name: 'send_note_to_tv', args: { message: 'I’ll ring at six. Sarah' }, title: 'send_note_to_tv' },
    ]);
    expect(result.plan).toEqual(['send_note_to_tv']);
    expect(mcp.calls).toEqual([]);
    expect(model.left).toBe(1);
  });

  it('treats a tool that says nothing about itself as a write', async () => {
    const result = await turn(ask('I’m coming Saturday'), [{ call: [{ name: 'expect_visit', input: { day: 'saturday' } }] }]).out;

    expect(result.needsApproval?.map((n) => n.name)).toEqual(['expect_visit']);
    expect(mcp.calls).toEqual([]);
  });

  it('after a yes, carries out exactly the call that was shown — in a new agent, from the saved session', async () => {
    const first = await turn(ask('Tell Mum I’ll ring at six'), [{ call: [{ name: 'send_note_to_tv', input: { message: 'I’ll ring at six.' } }] }]).out;

    const { model, out } = turn(answer(true), [{ say: 'I have put the note on her television.' }]);
    const result = await out;

    expect(first.needsApproval).toHaveLength(1);
    expect(mcp.calls).toEqual([{ name: 'send_note_to_tv', args: { message: 'I’ll ring at six.' } }]);
    expect(result.say).toBe('I have put the note on her television.');
    expect(result.trace).toEqual([{ tool: 'send_note_to_tv', ok: true, args: { message: 'I’ll ring at six.' } }]);
    expect(result.toolTexts).toEqual(['{"sent":true,"cardId":"card_1"}']);
    expect(result.asked).toBe('Tell Mum I’ll ring at six');
    // The model was not asked to choose again: it was shown what the tool returned.
    expect(JSON.stringify(model.seen[0]!.messages)).toContain('card_1');
  });

  it('after a no, does nothing, and the model is told the member chose not to', async () => {
    await turn(ask('Tell Mum I’ll ring at six'), [{ call: [{ name: 'send_note_to_tv', input: { message: 'Six.' } }] }]).out;

    const { model, out } = turn(answer(false), [{ say: 'All right, I have not sent it.' }]);
    const result = await out;

    expect(mcp.calls).toEqual([]);
    expect(result.say).toBe('All right, I have not sent it.');
    expect(result.trace).toEqual([{ tool: 'send_note_to_tv', ok: false, args: { message: 'Six.' }, declined: true }]);
    expect(JSON.stringify(model.seen[0]!.messages)).toContain(DECLINED_TEXT);
  });

  it('asks about every write of one step at once, and does only those said yes to', async () => {
    const first = await turn(ask('The plumber is coming Thursday at ten, let Mum know'), [
      { call: [
        { name: 'arrange_visit', input: { who: 'the plumber', day: 'thursday', time: '10:00' } },
        { name: 'send_note_to_tv', input: { message: 'The plumber is coming on Thursday at ten.' } },
      ] },
    ]).out;

    expect(first.needsApproval?.map((n) => n.name).sort()).toEqual(['arrange_visit', 'send_note_to_tv']);
    expect(first.plan).toHaveLength(2);

    const note = first.needsApproval!.find((n) => n.name === 'send_note_to_tv')!;
    const visit = first.needsApproval!.find((n) => n.name === 'arrange_visit')!;
    const result = await turn(answer({ [visit.id]: true, [note.id]: false }), [{ say: 'The door knows; I did not send the note.' }]).out;

    expect(mcp.calls.map((c) => c.name)).toEqual(['arrange_visit']);
    expect(result.trace.find((t) => t.tool === 'send_note_to_tv')).toMatchObject({ ok: false, declined: true });
    expect(result.trace.find((t) => t.tool === 'arrange_visit')).toMatchObject({ ok: true });
  });

  it('counts a yes it was not asked for as nothing: an id that was never waiting approves nothing', async () => {
    await turn(ask('Tell Mum'), [{ call: [{ name: 'send_note_to_tv', input: { message: 'Hi.' } }] }]).out;

    await turn(answer({ 'hook:beforeToolCall:made-up:approve': true }), [{ say: 'Not sent.' }]).out;

    expect(mcp.calls).toEqual([]);
  });

  it('asks again for a second write the model chooses after a yes: one yes is one call', async () => {
    await turn(ask('Tell Mum, and tell the door'), [{ call: [{ name: 'send_note_to_tv', input: { message: 'Hi.' } }] }]).out;

    const second = await turn(answer(true), [{ call: [{ name: 'expect_visit', input: { day: 'saturday' } }] }]).out;

    expect(mcp.calls.map((c) => c.name)).toEqual(['send_note_to_tv']);
    expect(second.needsApproval?.map((n) => n.name)).toEqual(['expect_visit']);
  });

  it('says there was nothing to answer when nothing was waiting', async () => {
    const { model, out } = turn(answer(true), []);

    expect((await out).say).toBe(NOTHING_WAITING_TEXT);
    expect(model.seen).toEqual([]);
    expect(mcp.calls).toEqual([]);
  });

  it('lets a waiting write go when the member asks something else, and never does it', async () => {
    await turn(ask('Tell Mum I’ll ring'), [{ call: [{ name: 'send_note_to_tv', input: { message: 'Ring.' } }] }]).out;

    const { model, out } = turn(ask('Did anyone come today?'), [{ say: 'Nobody yet.' }]);
    const result = await out;

    expect(result.say).toBe('Nobody yet.');
    expect(mcp.calls).toEqual([]);
    // The conversation the model is shown still alternates: the waiting call is closed, and said to be closed.
    const roles = model.seen[0]!.messages.map((m) => m.role);
    for (let i = 1; i < roles.length; i += 1) expect(roles[i]).not.toBe(roles[i - 1]);
    expect(roles.at(-1)).toBe('user');
  });
});

describe('the conversation, kept between questions', () => {
  it('is restored from storage by a new agent: what was asked before is still there', async () => {
    await turn(ask('Did anyone come today?'), [{ say: 'Six people.' }]).out;

    const { model, out } = turn(ask('And yesterday?'), [{ say: 'Two.' }]);
    await out;

    const shown = JSON.stringify(model.seen[0]!.messages);
    expect(shown).toContain('Did anyone come today?');
    expect(shown).toContain('Six people.');
  });

  it('is told today’s date, not the one saved with the session', async () => {
    await turn(ask('Hello'), [{ say: 'Hello.' }]).out;

    const later = Date.UTC(2026, 9, 15, 12);
    const { model, out } = turn(ask('Hello again'), [{ say: 'Hello.' }], { now: () => later });
    await out;

    expect(model.seen[0]!.system).toContain('Thursday 15 October 2026');
    expect(model.seen[0]!.system).not.toContain('Now it is Tuesday 13 October');
  });

  it('is the member’s own: another member of the same home starts with nothing', async () => {
    await turn(ask('Our plumber is Dave'), [{ say: 'Noted.' }]).out;

    const model = new ScriptedToolModel([{ say: 'Hello.' }]);
    await runAssistantTurn({ ...ask('Hello'), memberId: 'usr-tom' }, deps(model));

    expect(JSON.stringify(model.seen[0]!.messages)).not.toContain('Dave');
  });
});

describe('the member’s token goes to Wick’s server and nowhere else', () => {
  it('is never in the saved session, the answer or a log line — through a write, a yes and a reply', async () => {
    const first = await turn(ask('Tell Mum I’ll ring at six'), [{ call: [{ name: 'send_note_to_tv', input: { message: 'Six.' } }] }]).out;
    const afterInterrupt = await savedSession();
    const second = await turn(answer(true), [{ call: [{ name: 'get_today' }] }, { say: 'Sent.' }]).out;

    for (const kept of [afterInterrupt, await savedSession(), JSON.stringify(first), JSON.stringify(second), ...logged]) {
      expect(kept).not.toContain(TOKEN);
    }
    expect(afterInterrupt).toContain('send_note_to_tv');
  });
});

describe('the limits of one turn', () => {
  it('runs at most six rounds of tools, then says it is more than it can do', async () => {
    const round: Step = { call: [{ name: 'get_today' }] };
    const result = await turn(ask('Tell me everything'), [round, round, round, round, round, round, round, round, { say: 'never' }]).out;

    expect(mcp.calls).toHaveLength(6);
    expect(result.say).toBe(TOO_MANY_STEPS_TEXT);
  });

  it('runs no call of a step that asks for more than four at once', async () => {
    const five = { call: Array.from({ length: 5 }, () => ({ name: 'get_today' })) };
    const { model, out } = turn(ask('Everything at once'), [five, { say: 'One at a time, then.' }]);

    const result = await out;

    expect(mcp.calls).toEqual([]);
    expect(result.say).toBe('One at a time, then.');
    expect(JSON.stringify(model.seen[1]!.messages)).toContain('at most 4');
  });

  it('gives up when the turn takes longer than its time, and can be asked again', async () => {
    const slow = await turn(ask('Slowly'), [{ waitMs: 200, then: { say: 'Too late.' } }], { limits: { timeoutMs: 50 } }).out;

    expect(slow.say).toBe(TOO_SLOW_TEXT);
    const again = await turn(ask('Again'), [{ say: 'Here now.' }]).out;
    expect(again.say).toBe('Here now.');
  });
});

describe('remembering the member’s own words', () => {
  function rememberingStore(): MemoryStore & { added: MessageData[][] } {
    const added: MessageData[][] = [];
    return {
      name: 'member',
      writable: true,
      extraction: true,
      added,
      search: async () => [{ content: 'Our plumber is Dave.' }],
      addMessages: async (messages) => { added.push(messages); },
    };
  }

  it('puts what the member said before in front of the model, and keeps only their new words', async () => {
    const store = rememberingStore();
    const { model, out } = turn(ask('The plumber is coming Thursday'), [{ call: [{ name: 'get_today' }] }, { say: 'Thanks.' }], { memoryFor: () => store });

    await out;

    expect(JSON.stringify(model.seen[0]!.messages)).toContain('Our plumber is Dave.');
    const remembered = JSON.stringify(store.added);
    expect(remembered).toContain('The plumber is coming Thursday');
    expect(remembered).not.toContain('doorbell');
    expect(remembered).not.toContain('Thanks.');
  });
});

describe('readTurnRequest — the runtime trusts nothing it is sent', () => {
  const good = { kind: 'assistant.turn', householdId: HH, memberId: MEMBER, memberToken: TOKEN, who: WHO, timeZone: 'Europe/London', question: 'Hello' };

  it('takes a question or an answer, never both and never neither', () => {
    expect(readTurnRequest(good)).toMatchObject({ householdId: HH, question: 'Hello' });
    expect(readTurnRequest({ ...good, question: undefined, resume: { approved: true } })).toMatchObject({ resume: { approved: true } });
    expect(readTurnRequest({ ...good, resume: { approved: true } })).toBeUndefined();
    expect(readTurnRequest({ ...good, question: undefined })).toBeUndefined();
    expect(readTurnRequest({ ...good, question: '   ' })).toBeUndefined();
  });

  it('refuses a request without the member’s token, home or names', () => {
    for (const missing of ['memberToken', 'householdId', 'memberId', 'who']) {
      expect(readTurnRequest({ ...good, [missing]: undefined }), missing).toBeUndefined();
    }
    expect(readTurnRequest({ ...good, who: { ...WHO, simulated: 'yes' } })).toBeUndefined();
    expect(readTurnRequest({ ...good, resume: { approved: 'yes' }, question: undefined })).toBeUndefined();
    expect(readTurnRequest({ ...good, timeZone: 'Mars/Olympus' })).toBeUndefined();
  });

  it('cuts a question to what a person says in one go', () => {
    expect(readTurnRequest({ ...good, question: 'a'.repeat(2000) })?.question).toHaveLength(600);
  });
});

describe('assistantTurnHandler — the runtime kind "assistant.turn"', () => {
  const payload = { kind: 'assistant.turn', householdId: HH, memberId: MEMBER, memberToken: TOKEN, who: WHO, question: 'Hello' };

  it('answers in the member’s own runtime session', async () => {
    const model = new ScriptedToolModel([{ say: 'Hello Sarah.' }]);
    const handler = assistantTurnHandler(() => deps(model));

    const out = (await handler(payload, { sessionId: assistantSessionId(HH, MEMBER) })) as AssistantTurnOutput;

    expect(out.say).toBe('Hello Sarah.');
  });

  it('refuses a turn sent to another member’s runtime session', async () => {
    const model = new ScriptedToolModel([{ say: 'Hello.' }]);
    const handler = assistantTurnHandler(() => deps(model));

    expect(await handler(payload, { sessionId: assistantSessionId(HH, 'usr-tom') })).toEqual({ error: 'wrong_session' });
    expect(model.seen).toEqual([]);
  });

  it('says it is not set up, and asks no model, where the deployment gave it no server or model', async () => {
    expect(await assistantTurnHandler(() => undefined)(payload, { sessionId: '' })).toEqual({ error: 'not_configured' });
  });

  it('refuses what is not a turn', async () => {
    const model = new ScriptedToolModel([]);
    expect(await assistantTurnHandler(() => deps(model))({ kind: 'assistant.turn' }, { sessionId: '' })).toEqual({ error: 'bad_request' });
  });
});
