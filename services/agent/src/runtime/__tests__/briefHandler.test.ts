import { describe, expect, it, vi } from 'vitest';
import type { WeekNarrative } from '@wick/contracts';
import { briefWeeklyHandler, type BriefRun } from '../briefHandler.js';
import type { StoredWeek, WeekStore } from '../../agents/brief/store.js';
import type { BriefInput } from '../../graphs/weeklyBrief.js';

const week = (over: Partial<WeekNarrative> = {}): WeekNarrative => ({
  householdId: 'hh-1',
  isoWeek: '2026-W38',
  text: 'A quiet week.',
  textSource: 'model',
  deltas: [],
  timeline: [],
  generatedAt: 1000,
  ...over,
});

function setup(existing?: WeekNarrative) {
  const stored: StoredWeek | undefined = existing ? { narrative: existing, raw: JSON.stringify(existing) } : undefined;
  const runs: BriefInput[] = [];
  const cards: WeekNarrative[] = [];
  const asked: string[] = [];
  const weeks: WeekStore = {
    load: async (householdId, isoWeek) => {
      asked.push(`${householdId}/${isoWeek}`);
      return stored;
    },
    save: async () => true,
  };
  const run: BriefRun = async (input) => {
    runs.push(input);
    return { result: { status: 'written', textSource: 'agents', suggestion: { action: 'nothing', reason: 'Nothing to suggest this week.' }, attempts: 1 }, path: ['analyst'] };
  };
  const brief = briefWeeklyHandler((householdId) => ({
    weeks,
    run: (input) => run({ ...input, householdId }),
    sendWeekCard: async (narrative) => void cards.push(narrative),
  }));
  const handler = (payload: Record<string, unknown>) => brief(payload, { sessionId: 'wick-household-hh-1' });
  return { handler, runs, cards, asked, stored };
}

describe('brief.weekly — the runtime kind that writes one home’s week', () => {
  it('runs the graph for the session’s household and the week asked for, with the row as it was read', async () => {
    const s = setup();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const answer = await s.handler({ kind: 'brief.weekly', householdId: 'hh-1', isoWeek: '2026-W38' });
    const logged = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();

    expect(s.asked).toEqual(['hh-1/2026-W38']);
    expect(s.runs).toEqual([{ householdId: 'hh-1', isoWeek: '2026-W38' }]);
    expect(answer).toMatchObject({ status: 'written', textSource: 'agents', path: ['analyst'] });
    // Who wrote the week, and on which try, is in the log: the agents, or the counted facts after two refusals.
    expect(logged.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'brief_weekly')).toMatchObject({ status: 'written', textSource: 'agents', attempts: 1 });
  });

  it('refuses a request that is not a household and an ISO week', async () => {
    const s = setup();
    expect(await s.handler({ householdId: 'hh-1', isoWeek: 'last week' })).toEqual({ status: 'bad_request' });
    expect(await s.handler({ isoWeek: '2026-W38' })).toEqual({ status: 'bad_request' });
    expect(s.runs).toEqual([]);
  });

  it('is idempotent: a week the agents already wrote is not written again', async () => {
    const s = setup(week({ textSource: 'agents', residentSeenAt: 5 }));
    expect(await s.handler({ householdId: 'hh-1', isoWeek: '2026-W38' })).toEqual({ status: 'skipped', why: 'already_written' });
    expect(s.runs).toEqual([]);
  });

  it('sends her week card again when the agents wrote the week but she has not read it — a retry heals a card that was not sent', async () => {
    const written = week({ textSource: 'agents' });
    const s = setup(written);
    expect(await s.handler({ householdId: 'hh-1', isoWeek: '2026-W38' })).toEqual({ status: 'skipped', why: 'already_written', cardSent: true });
    expect(s.cards).toEqual([written]);
    expect(s.runs).toEqual([]);
  });

  it('never rewrites a week she has read (INV-7)', async () => {
    const s = setup(week({ residentSeenAt: 5 }));
    expect(await s.handler({ householdId: 'hh-1', isoWeek: '2026-W38' })).toEqual({ status: 'skipped', why: 'already_seen' });
    expect(s.runs).toEqual([]);
  });

  it('rewrites a demo home’s simulated week with what it keeps', async () => {
    const demo = week({ simulated: true, residentSeenAt: 7, generatedAt: 3, textSource: 'facts' });
    const s = setup(demo);

    await s.handler({ householdId: 'hh-1', isoWeek: '2026-W38' });

    expect(s.runs).toEqual([{ householdId: 'hh-1', isoWeek: '2026-W38', existing: { narrative: demo, raw: JSON.stringify(demo) }, keep: { simulated: true, residentSeenAt: 7, generatedAt: 3 } }]);
  });

  it('writes a demo home’s week only over a simulated one: a demo request never writes a lived week, nor one that is not there', async () => {
    const real = setup(week());
    expect(await real.handler({ householdId: 'hh-1', isoWeek: '2026-W38', origin: 'demo' })).toEqual({ status: 'skipped', why: 'not_a_demo_week' });
    const missing = setup();
    expect(await missing.handler({ householdId: 'hh-1', isoWeek: '2026-W38', origin: 'demo' })).toEqual({ status: 'skipped', why: 'not_a_demo_week' });
    expect([...real.runs, ...missing.runs]).toEqual([]);

    const demo = setup(week({ simulated: true, residentSeenAt: 7 }));
    await demo.handler({ householdId: 'hh-1', isoWeek: '2026-W38', origin: 'demo' });
    expect(demo.runs).toHaveLength(1);
  });
});
