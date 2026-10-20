/**
 * The Sunday brief as a Strands Graph, end to end, with a scripted model in
 * place of Sonnet and a Guardrail that answers as each test says. Every
 * other part is the real code: the Narrator's counting and checks, the
 * Guardian, the suggestion rules.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { ApplyGuardrailCommandInput } from '@aws-sdk/client-bedrock-runtime';
import type { WeekNarrative } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { BRIEF_NODES, WRITER_SYSTEM_PROMPT, runWeeklyBriefGraph, type BriefInput, type WeeklyBriefDeps } from '../weeklyBrief.js';
import type { GuardrailReply } from '../../agents/brief/guardrail.js';
import { STRUCTURED_OUTPUT_TOOL, TurnsModel, type Turn } from './turnsModel.js';

type Item = Record<string, AttributeValue>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// 2026-W38: Monday 14 to Sunday 20 September. The brief runs on its Sunday evening.
const W38_START = Date.UTC(2026, 8, 14);
const SUNDAY_EVENING = W38_START + 6 * DAY + 20 * HOUR;

const evt = (at: number, id: string, extra: Item = {}): Item => ({ pk: { S: 'HH#hh-1' }, sk: { S: `EVT#${String(at).padStart(15, '0')}#${id}` }, ...extra });
const door = (at: number, id: string) => evt(at, id, { type: { S: 'door' } });
const maria = (at: number, id: string) => evt(at, id, { type: { S: 'presence' }, personId: { S: 'maria' }, personName: { S: 'Maria' } });

/**
 * Seven weeks of a house: Maria on Tuesday and Friday mornings for six weeks,
 * and not at all this week; the door three times every week.
 */
function sevenWeeks(): Item[] {
  const items: Item[] = [];
  for (let weeksAgo = 6; weeksAgo >= 0; weeksAgo -= 1) {
    const monday = W38_START - weeksAgo * WEEK;
    items.push(door(monday + 10 * HOUR, `d1-${weeksAgo}`), door(monday + 2 * DAY + 15 * HOUR, `d2-${weeksAgo}`), door(monday + 5 * DAY + 11 * HOUR, `d3-${weeksAgo}`));
    if (weeksAgo > 0) items.push(maria(monday + DAY + 9 * HOUR, `m1-${weeksAgo}`), maria(monday + 4 * DAY + 9 * HOUR, `m2-${weeksAgo}`));
  }
  return items;
}

const GOOD_DRAFT = 'Someone came to the front door 3 times this week. Maria did not visit this week.';
const suggest = (action: string, reason: string): Turn => ({ tool: STRUCTURED_OUTPUT_TOOL, input: { action, reason } });

/** A Guardrail that intervenes on the sentences it is told to, and fails if told to. */
function guardrail(refuse: (content: string) => GuardrailReply | Error | undefined = () => undefined) {
  const asked: ApplyGuardrailCommandInput[] = [];
  return {
    asked,
    send: async (input: ApplyGuardrailCommandInput): Promise<GuardrailReply> => {
      asked.push(input);
      const content = input.content!.find((c) => c.text?.qualifiers?.includes('guard_content'))!.text!.text!;
      const answer = refuse(content);
      if (answer instanceof Error) throw answer;
      return answer ?? { action: 'NONE', assessments: [] };
    },
  };
}
const UNGROUNDED: GuardrailReply = {
  action: 'GUARDRAIL_INTERVENED',
  assessments: [{ contextualGroundingPolicy: { filters: [{ type: 'GROUNDING', threshold: 0.75, score: 0.2, action: 'BLOCKED', detected: true }] } }],
};

function setup(options: {
  writer: Turn[];
  suggester?: Turn[];
  guard?: ReturnType<typeof guardrail>;
  input?: Partial<BriefInput>;
  tv?: Item[];
  errands?: Item[];
  save?: (n: WeekNarrative) => boolean;
  sendWeekCard?: () => Promise<void>;
}) {
  const writer = new TurnsModel(options.writer);
  const suggester = new TurnsModel(options.suggester ?? [suggest('arrange_visit', 'Nobody came to the door when Maria was expected this week.')]);
  const guard = options.guard ?? guardrail();
  const saved: WeekNarrative[] = [];
  const cards: WeekNarrative[] = [];
  const deps: WeeklyBriefDeps = {
    writerModel: writer,
    suggesterModel: suggester,
    loadEvents: async () => sevenWeeks(),
    firstEventAt: async () => W38_START - 6 * WEEK + 10 * HOUR,
    loadErrands: async () => options.errands ?? [],
    loadTvActivity: async () => options.tv ?? [],
    loadPolicy: async () => DEFAULT_POLICY,
    guardrail: guard.send,
    guardrailRef: { id: 'gr-1', version: '1' },
    saveWeek: async (narrative) => {
      const ok = options.save?.(narrative) ?? true;
      if (ok) saved.push(narrative);
      return ok;
    },
    sendWeekCard: async (narrative) => {
      await options.sendWeekCard?.();
      cards.push(narrative);
    },
    now: () => SUNDAY_EVENING,
    timeZone: 'Europe/London',
  };
  const input: BriefInput = { householdId: 'hh-1', isoWeek: '2026-W38', ...options.input };
  return { deps, input, writer, suggester, guard, saved, cards, run: () => runWeeklyBriefGraph(input, deps) };
}

describe('the Sunday brief — analyst → writer → check → suggester → validate → store', () => {
  it('writes the week from the counted facts, checks it, picks one thing to do, and stores both', async () => {
    const s = setup({ writer: [GOOD_DRAFT] });

    const run = await s.run();

    expect(run.path).toEqual([BRIEF_NODES.analyst, BRIEF_NODES.writer, BRIEF_NODES.check, BRIEF_NODES.suggester, BRIEF_NODES.validate, BRIEF_NODES.store]);
    expect(run.result).toEqual({ status: 'written', textSource: 'agents', suggestion: { action: 'arrange_visit', reason: 'Nobody came to the door when Maria was expected this week.' }, attempts: 1 });
    expect(s.saved).toHaveLength(1);
    expect(s.saved[0]).toMatchObject({ householdId: 'hh-1', isoWeek: '2026-W38', text: GOOD_DRAFT, textSource: 'agents', generatedAt: SUNDAY_EVENING });
    expect(s.saved[0]!.residentSeenAt).toBeUndefined();
    expect(s.saved[0]!.simulated).toBeUndefined();
    expect(s.saved[0]!.timeline).toHaveLength(3);
    // INV-7: her copy goes to her television; nothing here marks it seen.
    expect(s.cards).toEqual([s.saved[0]]);
  });

  it('never asks the writer for a suggestion: the suggester makes the one suggestion, from a fixed menu', async () => {
    // Live, the graph's task ("…and suggest one thing they could do") reached the writer, and every
    // draft ended with advice of its own: too long the first time, ungrounded (0.02) the second.
    const s = setup({ writer: [GOOD_DRAFT] });
    await s.run();

    expect(s.writer.seen[0]).not.toMatch(/suggest|one thing|could do/i);
    expect(WRITER_SYSTEM_PROMPT).toMatch(/Never suggest anything the family could do/);
  });

  it('shows the writer counted facts only — never a raw timestamp — and the suggester only the actions the week allows', async () => {
    const s = setup({ writer: [GOOD_DRAFT] });
    await s.run();

    expect(s.writer.seen[0]).toContain('Someone came to the front door 3 times.');
    expect(s.writer.seen[0]).toContain('Nobody came to the door when Maria was expected this week.');
    expect(s.writer.seen[0]).not.toMatch(/\d{10,}/);
    expect(s.writer.options[0]?.toolSpecs ?? []).toEqual([]);

    expect(s.suggester.seen[0]).toContain(GOOD_DRAFT);
    expect(s.suggester.seen[0]).toContain('Allowed actions this week: send_note, arrange_visit, nothing.');
    expect(s.suggester.options[0]?.toolSpecs?.map((t) => t.name)).toEqual([STRUCTURED_OUTPUT_TOOL]);
  });

  it('asks the Guardrail with the fact lines as the grounding source, for the paragraph and for the reason', async () => {
    const s = setup({ writer: [GOOD_DRAFT] });
    await s.run();

    const guarded = s.guard.asked.map((a) => a.content!.find((c) => c.text?.qualifiers?.includes('guard_content'))!.text!.text);
    expect(guarded).toEqual([GOOD_DRAFT, 'Nobody came to the door when Maria was expected this week.']);
    const source = s.guard.asked[0]!.content!.find((c) => c.text?.qualifiers?.includes('grounding_source'))!.text!.text!;
    expect(source).toContain('Someone came to the front door 3 times.');
    // The reason is checked against the question it answers: why this action.
    const query = s.guard.asked[1]!.content!.find((c) => c.text?.qualifiers?.includes('query'))!.text!.text!;
    expect(query).toBe('Why might the family member arrange a visit this week?');
  });

  it('includes the visits the family arranged that week, and how they ended, in what the writer is told', async () => {
    const errand: Item = {
      pk: { S: 'HH#hh-1' },
      sk: { S: 'ERRAND#err_AAAAAAAAAAAAAAAAAAAA' },
      data: { S: JSON.stringify({ who: 'the plumber', createdByName: 'Sarah', at: W38_START + 3 * DAY + 10 * HOUR, status: 'rang' }) },
    };
    const s = setup({ writer: [GOOD_DRAFT], errands: [errand] });
    await s.run();
    expect(s.writer.seen[0]).toContain('A visit from the plumber was arranged: someone rang the doorbell around the time they were expected.');
    // The whole family reads the week: the member who arranged it is not named.
    expect(s.writer.seen[0]).not.toContain('Sarah');
  });
});

describe('the check — back to the writer once with the reason, then the facts alone', () => {
  it('sends a draft with a number the facts never gave back to the writer, saying why, through the analyst', async () => {
    const s = setup({ writer: ['Nine people came to the door.', GOOD_DRAFT] });

    const run = await s.run();

    expect(run.path).toEqual(['analyst', 'writer', 'check', 'analyst', 'writer', 'check', 'suggester', 'validate', 'store']);
    expect(s.writer.seen[1]).toMatch(/Your draft used "Nine", a number that is not in the facts/);
    expect(run.result).toMatchObject({ status: 'written', textSource: 'agents', attempts: 2 });
    expect(s.saved[0]!.text).toBe(GOOD_DRAFT);
  });

  it('writes the week from the facts alone when the second draft fails too', async () => {
    const s = setup({ writer: ['Nine people came.', 'Twelve people came.'] });

    const run = await s.run();

    expect(run.result).toMatchObject({ status: 'written', textSource: 'facts', attempts: 2 });
    expect(s.saved[0]!.text).toMatch(/^Someone came to the front door three times this week/);
    expect(s.saved[0]!.textSource).toBe('facts');
    // The week still has its one suggestion: the facts did not change.
    expect(s.saved[0]!.suggestion).toEqual({ action: 'arrange_visit', reason: 'Nobody came to the door when Maria was expected this week.' });
  });

  it('sends a draft the Guardrail finds ungrounded back, with its reason', async () => {
    const s = setup({ writer: ['The house was full of visitors this week.', GOOD_DRAFT], guard: guardrail((c) => (c === 'The house was full of visitors this week.' ? UNGROUNDED : undefined)) });

    const run = await s.run();

    expect(s.writer.seen[1]).toContain('it says something the facts do not support');
    expect(run.result).toMatchObject({ textSource: 'agents', attempts: 2 });
  });

  it('logs why a draft was refused, never the draft', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const s = setup({ writer: ['The house was full of visitors this week.', GOOD_DRAFT], guard: guardrail((c) => (c === 'The house was full of visitors this week.' ? UNGROUNDED : undefined)) });

      await s.run();

      const lines = spy.mock.calls.map((c) => String(c[0]));
      const refused = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'brief_draft_refused');
      expect(refused).toMatchObject({ attempt: 1, why: expect.stringContaining('it says something the facts do not support') });
      expect(lines.join('\n')).not.toContain('full of visitors');
    } finally {
      spy.mockRestore();
    }
  });

  it('sends a draft the Guardian will not let the family read back to the writer', async () => {
    const s = setup({ writer: ['Maria did not visit: perhaps the doctor came instead.', GOOD_DRAFT] });

    const run = await s.run();

    expect(s.writer.seen[1]).toMatch(/Wick never tells the family/);
    expect(run.result).toMatchObject({ textSource: 'agents', attempts: 2 });
  });

  it('writes the facts at once, and suggests nothing, when the Guardrail cannot be asked: nothing unchecked is written', async () => {
    const s = setup({ writer: [GOOD_DRAFT, GOOD_DRAFT], guard: guardrail(() => new Error('ThrottlingException')) });

    const run = await s.run();

    expect(s.writer.calls).toBe(1);
    expect(run.result).toMatchObject({ status: 'written', textSource: 'facts', suggestion: { action: 'nothing', reason: 'Nothing to suggest this week.' } });
  });
});

describe('a household whose people are written in another script', () => {
  const CARER = 'Мария';
  /** The same seven weeks, with the carer written in Cyrillic. */
  const cyrillicWeeks = (): Item[] => sevenWeeks().map((item) => (item.personId?.S === 'maria' ? { ...item, personId: { S: 'u-0123456789abcdef' }, personName: { S: CARER } } : item));
  const CARER_DRAFT = `Someone came to the front door 3 times this week. ${CARER} did not visit this week.`;

  function withCarer(people: readonly string[] | undefined, writer: Turn[], suggester?: Turn[]) {
    const s = setup({ writer, suggester: suggester ?? [suggest('arrange_visit', `${CARER} did not visit this week.`)] });
    const deps: WeeklyBriefDeps = { ...s.deps, loadEvents: async () => cyrillicWeeks(), ...(people ? { loadPeople: async () => people } : {}) };
    return { ...s, run: () => runWeeklyBriefGraph(s.input, deps) };
  }

  it('is written by the agents, with her name in it, when the Guardian is told whose names they are', async () => {
    const s = withCarer([CARER], [CARER_DRAFT]);

    const run = await s.run();

    expect(run.result).toMatchObject({ status: 'written', textSource: 'agents', attempts: 1, suggestion: { action: 'arrange_visit', reason: `${CARER} did not visit this week.` } });
    expect(s.saved).toHaveLength(1);
    expect(s.saved[0]).toMatchObject({ text: CARER_DRAFT, textSource: 'agents' });
  });

  it('is written from the facts, as before, when it is not told: a name nobody has vouched for is not read', async () => {
    const s = withCarer(undefined, [CARER_DRAFT, CARER_DRAFT]);

    const run = await s.run();

    expect(run.result).toMatchObject({ textSource: 'facts', attempts: 2 });
  });

  it('still refuses a draft that names a doctor beside her', async () => {
    const s = withCarer([CARER], [`${CARER} did not visit: perhaps the doctor came instead.`, CARER_DRAFT]);

    const run = await s.run();

    expect(s.writer.seen[1]).toMatch(/Wick never tells the family/);
    expect(run.result).toMatchObject({ textSource: 'agents', attempts: 2 });
  });

  it('does not stop the week when the circle cannot be read: it is written from the facts', async () => {
    const s = setup({ writer: [CARER_DRAFT, CARER_DRAFT] });
    const run = await runWeeklyBriefGraph(s.input, { ...s.deps, loadEvents: async () => cyrillicWeeks(), loadPeople: async () => { throw new Error('throttled'); } });

    expect(run.result).toMatchObject({ status: 'written', textSource: 'facts' });
  });
});

describe('validate — the suggestion, checked by code', () => {
  it('turns “watch together” into nothing when she watched no films that week', async () => {
    const s = setup({ writer: [GOOD_DRAFT], suggester: [suggest('watch_together', 'Watch a film with her.')] });
    const run = await s.run();
    expect(run.result).toMatchObject({ suggestion: { action: 'nothing', reason: 'Nothing to suggest this week.' } });
  });

  it('keeps “watch together” when a film was played that week', async () => {
    const tv: Item[] = [{ pk: { S: 'HH#hh-1' }, sk: { S: 'RHYTHM#tv_activity#wick-tv#power_on#THU-15' }, lastSeenAt: { N: String(W38_START + 3 * DAY + 15 * HOUR) } }];
    const s = setup({ writer: [GOOD_DRAFT], tv, suggester: [suggest('watch_together', 'A film was played on the television this week.')] });

    const run = await s.run();

    expect(s.suggester.seen[0]).toContain('Allowed actions this week: send_note, arrange_visit, watch_together, nothing.');
    expect(run.result).toMatchObject({ suggestion: { action: 'watch_together' } });
  });

  it('turns a reason the Guardrail finds ungrounded into nothing', async () => {
    const reason = 'She will love a visit from you.';
    const s = setup({ writer: [GOOD_DRAFT], suggester: [suggest('send_note', reason)], guard: guardrail((c) => (c === reason ? UNGROUNDED : undefined)) });
    const run = await s.run();
    expect(run.result).toMatchObject({ suggestion: { action: 'nothing' } });
  });

  it('turns a reason with a number the facts never gave into nothing', async () => {
    const s = setup({ writer: [GOOD_DRAFT], suggester: [suggest('send_note', 'Nine callers is a lot.')] });
    const run = await s.run();
    expect(run.result).toMatchObject({ suggestion: { action: 'nothing' } });
  });
});

describe('store — INV-7 untouched, and a demo home’s week kept simulated', () => {
  it('keeps a demo home’s week simulated, read when it was read, and sends no card for a week nobody lived', async () => {
    const s = setup({
      writer: [GOOD_DRAFT],
      input: { keep: { simulated: true, residentSeenAt: SUNDAY_EVENING - 3 * HOUR, generatedAt: SUNDAY_EVENING - 4 * HOUR } },
    });

    const run = await s.run();

    expect(run.result).toMatchObject({ status: 'written', textSource: 'agents' });
    expect(s.saved[0]).toMatchObject({ simulated: true, residentSeenAt: SUNDAY_EVENING - 3 * HOUR, generatedAt: SUNDAY_EVENING - 4 * HOUR });
    expect(s.cards).toEqual([]);
  });

  it('writes nothing, and sends no card, when the row changed after it was read', async () => {
    const s = setup({ writer: [GOOD_DRAFT], save: () => false });
    const run = await s.run();
    expect(run.result).toEqual({ status: 'not_written', why: 'changed_while_written' });
    expect(s.cards).toEqual([]);
  });

  it('fails, having stored nothing, when the writer’s model cannot be reached — the worker falls back to the Narrator', async () => {
    const s = setup({ writer: [new Error('ThrottlingException')] });
    const run = await s.run();
    expect(run.result).toMatchObject({ status: 'failed', stored: false });
    expect(s.saved).toEqual([]);
  });

  it('says the week was stored when only her card could not be sent, so it is not written twice', async () => {
    const s = setup({ writer: [GOOD_DRAFT], sendWeekCard: async () => { throw new Error('GoneException'); } });
    const run = await s.run();
    expect(run.result).toMatchObject({ status: 'failed', stored: true });
    expect(s.saved).toHaveLength(1);
  });
});
