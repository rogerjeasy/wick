/**
 * The family app's side of the assistant as an agent on AgentCore
 * (POST /assistant/turn): what is decided is in surface.js, with no DOM, and
 * tested here; main.js only puts it on the page, and is read for the wiring.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain browser module, deliberately untyped (no build step).
import { agentSteps, agentTrace, approvalsFor, presentPlan, readAgentTurn, presentTurn, describeCall } from '../surface.js';

const NOTE = { id: 'hook:beforeToolCall:t1:approve', name: 'send_note_to_tv', args: { message: 'The plumber comes Thursday.' }, title: 'Send a note to the television' };
const VISIT = { id: 'hook:beforeToolCall:t2:approve', name: 'arrange_visit', args: { who: 'the plumber', day: 'thursday', time: '10:00' }, title: 'Arrange a visit' };

describe('readAgentTurn — what the agent’s answer is', () => {
  it('is calls waiting for a yes, with the plan', () => {
    expect(readAgentTurn({ needsApproval: [NOTE, VISIT], plan: ['Send a note to the television', 'Arrange a visit'], trace: [], toolTexts: [] })).toEqual({
      kind: 'waiting',
      calls: [NOTE, VISIT],
      plan: ['Send a note to the television', 'Arrange a visit'],
    });
  });

  it('is a sentence to say, or the tools’ own sentences, with what the tools returned', () => {
    const trace = [{ tool: 'get_today', ok: true, args: {} }];
    expect(readAgentTurn({ say: 'Six people rang.', trace, toolTexts: ['{"doorbell":6}'] })).toEqual({ kind: 'answer', say: 'Six people rang.', trace, toolTexts: ['{"doorbell":6}'] });
    expect(readAgentTurn({ unsupported: true, trace, toolTexts: ['{"doorbell":6}'] })).toEqual({ kind: 'answer', say: undefined, trace, toolTexts: ['{"doorbell":6}'] });
  });

  it('is nothing the app can use when it is not one of those', () => {
    for (const body of [null, 'x', {}, { say: 1, trace: [], toolTexts: [] }, { needsApproval: [{ name: 'x' }], trace: [], toolTexts: [] }, { say: 'a', trace: [{}], toolTexts: [] }]) {
      expect(readAgentTurn(body), JSON.stringify(body)).toBeNull();
    }
  });
});

describe('presentPlan — "Here is what I’ll do", before any yes is asked for', () => {
  it('lists each thing the agent would do, in its order', () => {
    expect(presentPlan(['Arrange a visit', 'Send a note to the television'])).toEqual({ title: 'Here is what I’ll do', items: ['Arrange a visit', 'Send a note to the television'] });
  });
});

describe('approvalsFor — the member’s answer to each call, by the id the agent gave it', () => {
  it('pairs each yes or no with its call', () => {
    expect(approvalsFor([NOTE, VISIT], [true, false])).toEqual({ [NOTE.id]: true, [VISIT.id]: false });
  });

  it('counts anything but a yes as a no', () => {
    expect(approvalsFor([NOTE, VISIT], [true])).toEqual({ [NOTE.id]: true, [VISIT.id]: false });
  });
});

describe('agentSteps — the agent’s calls, as the app’s own steps', () => {
  it('turns each call into a step the app presents as it presents its own, and a declined one into a step not taken', () => {
    const steps = agentSteps(
      {
        trace: [{ tool: 'arrange_visit', ok: true, args: VISIT.args }, { tool: 'send_note_to_tv', ok: false, args: NOTE.args, declined: true }],
        toolTexts: ['{"errandId":"err_1"}', 'The member chose not to do this. Nothing was sent or changed.'],
      },
      (name: string, text: string, args: unknown, isError: boolean) => ({ say: `${name}:${text}:${isError}`, card: null, tone: 'answer', args }),
    );

    expect(steps).toEqual([
      { name: 'arrange_visit', args: VISIT.args, presented: { say: 'arrange_visit:{"errandId":"err_1"}:false', card: null, tone: 'answer', args: VISIT.args } },
      { name: 'send_note_to_tv', args: NOTE.args, presented: null },
    ]);
    expect(presentTurn(undefined, steps).trace).toBe(`${describeCall('arrange_visit')} · Did not send the note`);
  });
});

describe('agentTrace — the line that says who did the work', () => {
  it('names Wick’s agent on Amazon Bedrock AgentCore and the tools it used, each once, in order', () => {
    expect(agentTrace([
      { tool: 'arrange_visit', ok: true },
      { tool: 'send_note_to_tv', ok: true },
      { tool: 'arrange_visit', ok: true },
    ])).toBe('Wick’s agent on Amazon Bedrock AgentCore used: arrange_visit, send_note_to_tv');
  });

  it('leaves out a call the member said no to, and says nothing when nothing was used', () => {
    expect(agentTrace([{ tool: 'get_today', ok: true }, { tool: 'send_note_to_tv', ok: false, declined: true }])).toBe('Wick’s agent on Amazon Bedrock AgentCore used: get_today');
    expect(agentTrace([])).toBe('');
  });
});

describe('the conversation in main.js', () => {
  const main = readFileSync(fileURLToPath(new URL('../main.js', import.meta.url)), 'utf8');

  it('asks the agent on AgentCore first, and only then the stand-in, unchanged', () => {
    expect(main).toMatch(/async function converse\(text\) \{\n {2}\/\/[^\n]*\n {2}if \(await converseWithAgent\(text\)\) return true;/);
    expect(main).toMatch(/authorizedFetch\('\/assistant\/turn', \{/);
    expect(main).toMatch(/const res = await authorizedFetch\('\/assistant\/next', \{/);
  });

  it('shows the plan, then asks about each call on the app’s own confirm card, then sends the answers back', () => {
    expect(main).toMatch(/showPlan\(turn, presentPlan\(answer\.plan\)\);/);
    expect(main).toMatch(/answers\.push\(await confirmInTurn\(turn, \{ name: call\.name, args: call\.args \}, call\.title\)\);/);
    expect(main).toMatch(/agentTurn\(\{ resume: \{ approved: approvalsFor\(answer\.calls, answers\) \} \}\)/);
  });

  it('falls back only when nothing was done: a failure after a yes is said, not asked again of the stand-in', () => {
    expect(main).toMatch(/if \(!asked\) \{\n {4}turn\.remove\(\);\n {4}return false;\n {2}\}/);
    expect(main).toMatch(/AGENT_STOPPED_TEXT/);
  });

  it('says which agent did the work', () => {
    expect(main).toMatch(/const used = agentTrace\(answer\.trace\);/);
  });
});
