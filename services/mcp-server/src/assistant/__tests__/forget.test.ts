import { describe, expect, it } from 'vitest';
import { ASSISTANT_AGENT_ID, assistantSessionId } from '@wick/agent';
import { agentCoreForgetting, type MemorySend } from '../forget.js';

const MEMORY = 'wick_assistant-abcdefghij';

interface Sent {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/**
 * AgentCore Memory as far as forgetting goes: events by actor and session,
 * records by namespace, two to a page.
 */
function fakeMemory(events: Record<string, string[]>, records: Record<string, string[]>, opts: { failRecord?: string } = {}) {
  const sent: Sent[] = [];
  const page = <T>(all: T[], token: unknown): { items: T[]; next?: string } => {
    const from = typeof token === 'string' ? Number(token) : 0;
    return { items: all.slice(from, from + 2), ...(from + 2 < all.length ? { next: String(from + 2) } : {}) };
  };
  const send: MemorySend = async (command) => {
    const name = command.constructor.name;
    const input = command.input as unknown as Record<string, unknown>;
    sent.push({ name, input });
    if (name === 'ListEventsCommand') {
      const key = `${input.actorId}|${input.sessionId}`;
      if (!(key in events)) throw Object.assign(new Error('no such session'), { name: 'ResourceNotFoundException' });
      const { items, next } = page(events[key]!, input.nextToken);
      return { events: items.map((eventId) => ({ eventId })), ...(next ? { nextToken: next } : {}) };
    }
    if (name === 'DeleteEventCommand') {
      const key = `${input.actorId}|${input.sessionId}`;
      events[key] = events[key]!.filter((id) => id !== input.eventId);
      return {};
    }
    if (name === 'ListMemoryRecordsCommand') {
      const { items, next } = page(records[input.namespace as string] ?? [], input.nextToken);
      return { memoryRecordSummaries: items.map((memoryRecordId) => ({ memoryRecordId })), ...(next ? { nextToken: next } : {}) };
    }
    if (name === 'BatchDeleteMemoryRecordsCommand') {
      const ids = (input.records as { memoryRecordId: string }[]).map((r) => r.memoryRecordId);
      const failed = ids.filter((id) => id === opts.failRecord);
      for (const ns of Object.keys(records)) records[ns] = records[ns]!.filter((id) => !ids.includes(id) || failed.includes(id));
      return { successfulRecords: [], failedRecords: failed.map((memoryRecordId) => ({ memoryRecordId, status: 'FAILED' })) };
    }
    throw new Error(`unexpected ${name}`);
  };
  return { send, sent, events, records };
}

const conversation = (hh: string, member: string) => `${ASSISTANT_AGENT_ID}|${assistantSessionId(hh, member)}`;
const words = (hh: string, member: string) => `${member}|${hh}`;
const ns = (hh: string, member: string) => `/households/${hh}/members/${member}`;

describe('agentCoreForgetting — a member’s memory in a home, taken with their account', () => {
  it('deletes every event of their conversation and of their words, page by page', async () => {
    const memory = fakeMemory(
      { [conversation('hh_1', 'tom')]: ['1#a', '2#b', '3#c'], [words('hh_1', 'tom')]: ['4#d', '5#e'] },
      {},
    );

    await agentCoreForgetting(memory.send, MEMORY).forget('hh_1', 'tom');

    expect(memory.events).toEqual({ [conversation('hh_1', 'tom')]: [], [words('hh_1', 'tom')]: [] });
    expect(memory.sent.filter((s) => s.name === 'DeleteEventCommand').every((s) => s.input.memoryId === MEMORY)).toBe(true);
  });

  it('deletes every long-term record under their namespace, and says so if one would not go', async () => {
    const memory = fakeMemory({}, { [ns('hh_1', 'tom')]: ['mem-1', 'mem-2', 'mem-3'] });

    await agentCoreForgetting(memory.send, MEMORY).forget('hh_1', 'tom');

    expect(memory.records[ns('hh_1', 'tom')]).toEqual([]);

    const stuck = fakeMemory({}, { [ns('hh_1', 'tom')]: ['mem-1'] }, { failRecord: 'mem-1' });
    await expect(agentCoreForgetting(stuck.send, MEMORY).forget('hh_1', 'tom')).rejects.toThrow();
  });

  it('finds nothing to delete for somebody who never asked the assistant anything', async () => {
    const memory = fakeMemory({}, {});

    await expect(agentCoreForgetting(memory.send, MEMORY).forget('hh_1', 'tom')).resolves.toBeUndefined();
  });

  it('touches nobody else’s: not another member’s in the same home, not theirs in another home', async () => {
    const memory = fakeMemory(
      {
        [conversation('hh_1', 'tom')]: ['1#a'],
        [conversation('hh_1', 'sarah')]: ['2#b'],
        [conversation('hh_2', 'tom')]: ['3#c'],
        [words('hh_1', 'sarah')]: ['4#d'],
      },
      { [ns('hh_1', 'sarah')]: ['mem-s'], [ns('hh_2', 'tom')]: ['mem-t2'] },
    );

    await agentCoreForgetting(memory.send, MEMORY).forget('hh_1', 'tom');

    expect(memory.events[conversation('hh_1', 'sarah')]).toEqual(['2#b']);
    expect(memory.events[conversation('hh_2', 'tom')]).toEqual(['3#c']);
    expect(memory.events[words('hh_1', 'sarah')]).toEqual(['4#d']);
    expect(memory.records).toEqual({ [ns('hh_1', 'sarah')]: ['mem-s'], [ns('hh_2', 'tom')]: ['mem-t2'] });
    for (const s of memory.sent.filter((s) => s.name === 'ListMemoryRecordsCommand')) expect(s.input.namespace).toBe(ns('hh_1', 'tom'));
  });

  it('still forgets the conversation of an id the memory never had words for', async () => {
    const memory = fakeMemory({ [conversation('hh_1', '-odd')]: ['1#a'] }, {});

    await agentCoreForgetting(memory.send, MEMORY).forget('hh_1', '-odd');

    expect(memory.events[conversation('hh_1', '-odd')]).toEqual([]);
  });
});
