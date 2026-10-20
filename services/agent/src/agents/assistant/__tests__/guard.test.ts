import type { ApplyGuardrailCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuardrailReply } from '../../brief/guardrail.js';
import { guardReplyWith, houseFacts } from '../guard.js';

const REF = { id: 'gr-1', version: '1' };

function guardrail(reply: GuardrailReply | Error) {
  const asked: ApplyGuardrailCommandInput[] = [];
  const send = async (input: ApplyGuardrailCommandInput): Promise<GuardrailReply> => {
    asked.push(input);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { asked, send };
}

describe('guardReplyWith — the Guardrail on what the assistant says', () => {
  it('grounds a reply on the tools’ own texts, against the member’s question', async () => {
    const g = guardrail({ action: 'NONE', assessments: [] });

    expect(await guardReplyWith(g.send, REF)('Three callers at the door.', { question: 'How was her week?', toolTexts: ['3 callers at the door this week.'] })).toBe(true);

    expect(g.asked[0]!.content).toEqual([
      { text: { text: '3 callers at the door this week.', qualifiers: ['grounding_source'] } },
      { text: { text: 'How was her week?', qualifiers: ['query'] } },
      { text: { text: 'Three callers at the door.', qualifiers: ['guard_content'] } },
    ]);
  });

  it('grounds on the tools’ answers with their moments and weeks written out at the house’s time zone', async () => {
    const g = guardrail({ action: 'NONE', assessments: [] });
    const tool = JSON.stringify({ isoWeek: '2026-W41', timeline: [{ at: Date.UTC(2026, 9, 6, 9, 0), summary: 'Maria visited.' }] });

    await guardReplyWith(g.send, REF)('Maria visited on Tuesday.', { question: 'How was her week?', toolTexts: [tool], timeZone: 'Europe/London' });

    const source = g.asked[0]!.content!.find((c) => c.text?.qualifiers?.includes('grounding_source'))!.text!.text!;
    expect(source).toContain('the week of Monday 5 October 2026');
    expect(source).toContain('Tuesday 6 October 2026, 10:00');
  });

  it('puts who is who and how a note waits beside the tools’ texts, so a true reply in plain words is grounded', async () => {
    const g = guardrail({ action: 'NONE', assessments: [] });
    const who = { memberName: 'Sarah', residentName: 'Margaret', householdName: 'Margaret’s home', simulated: true };

    await guardReplyWith(g.send, REF)('Sent. Margaret will see your note at the next natural break.', { question: 'Send her a note', toolTexts: ['{"sent":true}'], who });

    const source = g.asked[0]!.content!.find((c) => c.text?.qualifiers?.includes('grounding_source'))!.text!.text!;
    expect(source.split('\n')).toEqual([houseFacts(who), '{"sent":true}']);
    expect(houseFacts(who)).toContain('A reply to a note is Margaret\'s reply');
    expect(houseFacts(who)).toContain('next natural break');
  });

  it('never grounds a reply on that line alone: with no tool text there is still nothing to ground on', async () => {
    const g = guardrail({ action: 'NONE', assessments: [] });

    await guardReplyWith(g.send, REF)('What time is the plumber coming?', { toolTexts: [], who: { memberName: 'Sarah', residentName: 'Margaret', householdName: 'x', simulated: true } });

    expect(g.asked[0]!.content).toEqual([{ text: { text: 'What time is the plumber coming?', qualifiers: ['guard_content'] } }]);
  });

  it('still asks the Guardrail about a reply that called no tool, a clarifying question: its topics and filters read it', async () => {
    const g = guardrail({ action: 'NONE', assessments: [] });

    expect(await guardReplyWith(g.send, REF)('What time is the plumber coming?', { toolTexts: [] })).toBe(true);

    expect(g.asked[0]!.content).toEqual([{ text: { text: 'What time is the plumber coming?', qualifiers: ['guard_content'] } }]);
  });

  describe('says why it refused, in the log, and never what was refused', () => {
    afterEach(() => vi.restoreAllMocks());
    const logged = () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      return () => spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    };

    it('names the policy that intervened', async () => {
      const lines = logged();
      const g = guardrail({ action: 'GUARDRAIL_INTERVENED', assessments: [{ topicPolicy: { topics: [{ name: 'guessing-her-mood', type: 'DENY', action: 'BLOCKED' }] } }] });

      expect(await guardReplyWith(g.send, REF)('She seems lonely this week.', { question: 'How is she?', toolTexts: ['3 callers.'] })).toBe(false);

      expect(lines()).toEqual([{ level: 'warn', msg: 'assistant_guardrail_refused', why: 'it strays into guessing-her-mood' }]);
      expect(JSON.stringify(lines())).not.toContain('lonely');
    });

    it('names the error when the Guardrail could not be asked', async () => {
      const lines = logged();
      const err = Object.assign(new Error('Input is too long'), { name: 'ValidationException' });

      expect(await guardReplyWith(guardrail(err).send, REF)('Hello.', { toolTexts: [] })).toBe(false);

      expect(lines()).toEqual([{ level: 'warn', msg: 'assistant_guardrail_unavailable', error: 'ValidationException: Input is too long' }]);
    });
  });

  it('refuses a reply the Guardrail intervenes on, and one it could not be asked about', async () => {
    expect(await guardReplyWith(guardrail({ action: 'GUARDRAIL_INTERVENED', assessments: [] }).send, REF)('She seems lonely.', { toolTexts: [] })).toBe(false);
    expect(await guardReplyWith(guardrail(new Error('ThrottlingException')).send, REF)('Hello.', { toolTexts: [] })).toBe(false);
  });
});
