import { describe, expect, it } from 'vitest';
import { briefMessage, dispatchWeek, readBriefMessage, workBatch, workMessage, type SendBatch, type WorkDeps } from '../fanout.js';

describe('briefMessage / readBriefMessage — one home’s week, as a queue message', () => {
  it('round-trips the household, the week and where it came from', () => {
    const body = briefMessage({ householdId: 'hh-1', isoWeek: '2026-W38', origin: 'weekly' });
    expect(readBriefMessage(body)).toEqual({ householdId: 'hh-1', isoWeek: '2026-W38', origin: 'weekly' });
  });

  it('reads nothing it was not sent: no household, no week, an origin it does not know, not JSON', () => {
    expect(readBriefMessage(JSON.stringify({ isoWeek: '2026-W38', origin: 'weekly' }))).toBeUndefined();
    expect(readBriefMessage(JSON.stringify({ householdId: 'hh-1', isoWeek: 'soon', origin: 'weekly' }))).toBeUndefined();
    expect(readBriefMessage(JSON.stringify({ householdId: 'hh-1', isoWeek: '2026-W38', origin: 'someone' }))).toBeUndefined();
    expect(readBriefMessage('{')).toBeUndefined();
  });
});

describe('dispatchWeek — one message per home with a television', () => {
  it('sends every home, ten to a batch, each its own message', async () => {
    const batches: { Id: string; MessageBody: string }[][] = [];
    const sendBatch: SendBatch = async (entries) => {
      batches.push([...entries]);
      return { failed: [] };
    };
    const homes = Array.from({ length: 23 }, (_, i) => `hh-${i}`);

    const sent = await dispatchWeek('2026-W38', { listHouseholds: async () => homes, sendBatch });

    expect(sent).toEqual({ queued: 23 });
    expect(batches.map((b) => b.length)).toEqual([10, 10, 3]);
    expect(readBriefMessage(batches[2]![2]!.MessageBody)).toEqual({ householdId: 'hh-22', isoWeek: '2026-W38', origin: 'weekly' });
    expect(new Set(batches.flat().map((e) => e.Id)).size).toBe(23);
  });

  it('throws when any message was not queued, so the whole dispatch is tried again — each home’s week is written once whatever happens', async () => {
    const sendBatch: SendBatch = async (entries) => ({ failed: [entries[0]!.Id] });
    await expect(dispatchWeek('2026-W38', { listHouseholds: async () => ['a', 'b'], sendBatch })).rejects.toThrow('brief_dispatch_incomplete');
  });
});

describe('workMessage — the agents write the week, or the Narrator does', () => {
  const weekly = { householdId: 'hh-1', isoWeek: '2026-W38', origin: 'weekly' as const };
  function deps(answer: unknown | Error, narrated: 'written' | 'failed' = 'written', stored: 'none' | 'unread' | 'read' = 'none') {
    const calls: string[] = [];
    const d: WorkDeps = {
      storedWeek: async (householdId, isoWeek) => {
        calls.push(`look ${householdId} ${isoWeek}`);
        return stored;
      },
      invokeBrief: async (householdId, isoWeek, origin) => {
        calls.push(`brief ${householdId} ${isoWeek}${origin === 'demo' ? ' demo' : ''}`);
        if (answer instanceof Error) throw answer;
        return answer;
      },
      narrate: async (householdId, isoWeek) => {
        calls.push(`narrator ${householdId} ${isoWeek}`);
        return narrated === 'written';
      },
    };
    return { calls, d };
  }

  it('is done when the agents wrote the week, or had nothing to write', async () => {
    for (const answer of [{ status: 'written' }, { status: 'skipped', why: 'already_written' }, { status: 'not_written', why: 'changed_while_written' }]) {
      const { calls, d } = deps(answer);
      expect(await workMessage(weekly, d)).toBe(answer.status);
      expect(calls).toEqual(['brief hh-1 2026-W38']);
    }
  });

  it('falls back to the Narrator for that one home when the runtime cannot be reached, so a week is always written', async () => {
    const { calls, d } = deps(new Error('agentcore_timeout'));
    expect(await workMessage(weekly, d)).toBe('narrated');
    expect(calls).toEqual(['brief hh-1 2026-W38', 'look hh-1 2026-W38', 'narrator hh-1 2026-W38']);
  });

  it('falls back to the Narrator when the agents failed having stored nothing', async () => {
    const { calls, d } = deps({ status: 'failed', stored: false, error: 'writer: ThrottlingException' });
    expect(await workMessage(weekly, d)).toBe('narrated');
    expect(calls).toHaveLength(3);
  });

  it('asks for a retry, not the Narrator, when the week was stored but her card was not sent — the retry sends it', async () => {
    const { calls, d } = deps({ status: 'failed', stored: true, error: 'store: GoneException' });
    await expect(workMessage(weekly, d)).rejects.toThrow('brief_card_not_sent');
    expect(calls).toEqual(['brief hh-1 2026-W38']);
  });

  it('never lets the Narrator write over a week that is already stored and unread: it asks for a retry, which the agents answer', async () => {
    const { calls, d } = deps(new Error('agentcore_500'), 'written', 'unread');
    await expect(workMessage(weekly, d)).rejects.toThrow('brief_week_stored_retry');
    expect(calls).toEqual(['brief hh-1 2026-W38', 'look hh-1 2026-W38']);
  });

  it('leaves a week she has already read exactly as she read it, whatever the runtime says', async () => {
    const { calls, d } = deps(new Error('ThrottlingException'), 'written', 'read');
    expect(await workMessage(weekly, d)).toBe('skipped');
    expect(calls).toEqual(['brief hh-1 2026-W38', 'look hh-1 2026-W38']);
  });

  it('asks for a retry when the Narrator could not write the week either', async () => {
    const { d } = deps(new Error('down'), 'failed');
    await expect(workMessage(weekly, d)).rejects.toThrow('week_not_written');
  });

  it('never falls back to the Narrator for a demo home: its week is already there, and simulated', async () => {
    const { calls, d } = deps(new Error('down'));
    await expect(workMessage({ ...weekly, origin: 'demo' }, d)).rejects.toThrow('down');
    // And the runtime is told it is a demo home's week, so it writes only over a simulated one.
    expect(calls).toEqual(['brief hh-1 2026-W38 demo']);
  });
});

describe('workBatch — SQS partial batch failure reporting', () => {
  it('reports only the messages that failed, and drops one it cannot read rather than retry it for ever', async () => {
    const good = briefMessage({ householdId: 'hh-1', isoWeek: '2026-W38', origin: 'weekly' });
    const bad = briefMessage({ householdId: 'hh-2', isoWeek: '2026-W38', origin: 'weekly' });
    const result = await workBatch(
      { Records: [{ messageId: 'm1', body: good }, { messageId: 'm2', body: bad }, { messageId: 'm3', body: 'not json' }] },
      async (message) => {
        if (message.householdId === 'hh-2') throw new Error('down');
        return 'written';
      },
    );
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
  });
});
