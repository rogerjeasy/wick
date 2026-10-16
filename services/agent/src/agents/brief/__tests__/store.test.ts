import { describe, expect, it } from 'vitest';
import type { WeekNarrative } from '@wick/contracts';
import { briefDecision, weekStore, writtenByAgents, type WeekSend } from '../store.js';

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
const stored = (narrative: WeekNarrative) => ({ narrative, raw: JSON.stringify(narrative) });

describe('briefDecision — whether the agents write this week', () => {
  it('writes a week that has no story yet', () => {
    expect(briefDecision(undefined)).toEqual({ write: true });
  });

  it('does not write a week the agents already wrote: a message delivered twice costs nothing twice', () => {
    expect(briefDecision(stored(week({ textSource: 'agents' })))).toEqual({ write: false, why: 'already_written' });
    // Their paragraph failed its checks and the facts were used, but the brief still wrote it: its suggestion says so.
    expect(briefDecision(stored(week({ textSource: 'facts', suggestion: { action: 'nothing', reason: 'Nothing to suggest this week.' } })))).toEqual({
      write: false,
      why: 'already_written',
    });
  });

  it('never rewrites a week she has already read (INV-7): the family reads what she read', () => {
    expect(briefDecision(stored(week({ residentSeenAt: 2000 })))).toEqual({ write: false, why: 'already_seen' });
  });

  it('rewrites a narrator week she has not read yet: it is still hers to read first', () => {
    expect(briefDecision(stored(week({ textSource: 'facts' })))).toEqual({ write: true });
  });

  it('rewrites a demo home’s simulated week, keeping it simulated and keeping when it was written and read', () => {
    const demo = week({ simulated: true, residentSeenAt: 3000, generatedAt: 1000, textSource: 'facts' });
    expect(briefDecision(stored(demo))).toEqual({ write: true, keep: { simulated: true, residentSeenAt: 3000, generatedAt: 1000 } });
  });
});

describe('writtenByAgents', () => {
  it('is the agents’ own week, by its source or by its suggestion', () => {
    expect(writtenByAgents(week({ textSource: 'agents' }))).toBe(true);
    expect(writtenByAgents(week({ suggestion: { action: 'send_note', reason: 'x' } }))).toBe(true);
    expect(writtenByAgents(week())).toBe(false);
  });
});

describe('weekStore — the NARR# row, written only over what was read', () => {
  function table(initial?: WeekNarrative) {
    const rows = new Map<string, string>();
    if (initial) rows.set(`HH#${initial.householdId}|NARR#${initial.isoWeek}`, JSON.stringify(initial));
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const send: WeekSend = async (cmd) => {
      const { input } = cmd as unknown as { input: Record<string, unknown> };
      const name = cmd.constructor.name;
      sent.push({ name, input });
      const key = input.Key as Record<string, { S: string }> | undefined;
      const item = input.Item as Record<string, { S: string }> | undefined;
      if (name === 'GetItemCommand') {
        const data = rows.get(`${key!.pk!.S}|${key!.sk!.S}`);
        return { Item: data === undefined ? undefined : { data: { S: data } } };
      }
      const id = `${item!.pk!.S}|${item!.sk!.S}`;
      const current = rows.get(id);
      const values = input.ExpressionAttributeValues as Record<string, { S: string }> | undefined;
      const allowed = input.ConditionExpression === 'attribute_not_exists(pk)' ? current === undefined : current === values?.[':read']?.S;
      if (!allowed) throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
      rows.set(id, item!.data!.S);
      return {};
    };
    return { rows, sent, send };
  }

  it('loads a week with the exact text it was read as', async () => {
    const t = table(week());
    const loaded = await weekStore(t.send, 'wick').load('hh-1', '2026-W38');
    expect(loaded).toEqual({ narrative: week(), raw: JSON.stringify(week()) });
    expect(await weekStore(t.send, 'wick').load('hh-1', '2026-W39')).toBeUndefined();
  });

  it('writes a new week only where there was none', async () => {
    const t = table();
    expect(await weekStore(t.send, 'wick').save(week({ textSource: 'agents' }), undefined)).toBe(true);
    expect(JSON.parse(t.rows.get('HH#hh-1|NARR#2026-W38')!).textSource).toBe('agents');
  });

  it('does not write over a week that changed after it was read — her press marking it seen, say', async () => {
    const before = stored(week());
    const t = table(week({ residentSeenAt: 5000 }));

    expect(await weekStore(t.send, 'wick').save(week({ textSource: 'agents' }), before)).toBe(false);
    expect(JSON.parse(t.rows.get('HH#hh-1|NARR#2026-W38')!).residentSeenAt).toBe(5000);
  });

  it('writes over the very week it read', async () => {
    const t = table(week());
    expect(await weekStore(t.send, 'wick').save(week({ textSource: 'agents' }), stored(week()))).toBe(true);
  });
});
