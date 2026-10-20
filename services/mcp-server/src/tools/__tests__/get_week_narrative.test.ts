import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { FactClass, WeekNarrative } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  WEEK_AWAITING_RESIDENT_TEXT,
  WEEK_NOT_WRITTEN_TEXT,
  WEEK_NOT_WRITTEN_THEN_TEXT,
  familyWeek,
  latestReadableWeek,
  loadWeekNarrative,
  registerGetWeekNarrative,
  spokenFromThen,
  upgradeLegacyWeek,
} from '../get_week_narrative.js';
import { allowedContext } from './toolContext.js';

const NARRATIVE: WeekNarrative = {
  householdId: 'hh-1',
  isoWeek: '2026-W38',
  text: 'A quiet week. Margaret had her usual Tuesday visit from Maria.',
  deltas: [],
  timeline: [{ at: 1, kind: 'visit', summary: 'Maria visited, as usual.' }],
  generatedAt: 100,
  residentSeenAt: 200,
};

describe('loadWeekNarrative', () => {
  it('returns the narrative once the resident has seen it (INV-7)', async () => {
    const ddb = {
      send: vi.fn().mockResolvedValue({ Item: { data: { S: JSON.stringify(NARRATIVE) } } }),
    } as unknown as DynamoDBClient;
    const result = await loadWeekNarrative(ddb, 'hh-1', '2026-W38');
    expect(result).toEqual({ status: 'available', narrative: NARRATIVE });
  });

  it('withholds a narrative the resident has not yet seen (INV-7)', async () => {
    const unseen = { ...NARRATIVE, residentSeenAt: undefined };
    const ddb = {
      send: vi.fn().mockResolvedValue({ Item: { data: { S: JSON.stringify(unseen) } } }),
    } as unknown as DynamoDBClient;
    const result = await loadWeekNarrative(ddb, 'hh-1', '2026-W38');
    expect(result).toEqual({ status: 'awaiting_resident' });
  });

  it('reports not_written when no narrative exists for the week', async () => {
    const ddb = { send: vi.fn().mockResolvedValue({ Item: undefined }) } as unknown as DynamoDBClient;
    const result = await loadWeekNarrative(ddb, 'hh-1', '2026-W38');
    expect(result).toEqual({ status: 'not_written' });
  });
});

describe('get_week_narrative INV-7 guard (end-to-end through the registered tool)', () => {
  it('never returns narrative JSON when residentSeenAt is unset, even though the record exists', async () => {
    const unseen = { ...NARRATIVE, residentSeenAt: undefined };
    const ddb = {
      send: vi.fn().mockResolvedValue({ Item: { data: { S: JSON.stringify(unseen) } } }),
    } as unknown as DynamoDBClient;

    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerGetWeekNarrative(mcpServer, ddb, allowedContext('hh-1'));

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'get_week_narrative', arguments: { isoWeek: '2026-W38' } });
    const content = result.content as { type: string; text: string }[];

    // Says why, in the product's own voice — and never leaks the text or timeline.
    expect(content[0]!.text).not.toContain(unseen.text);
    expect(content[0]!.text).toBe(WEEK_AWAITING_RESIDENT_TEXT);
  });

  it('says plainly when no week has been written yet', async () => {
    const ddb = { send: vi.fn().mockResolvedValue({ Item: undefined }) } as unknown as DynamoDBClient;
    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    // Asked during 2026-W38 itself: "this week" is the week that was named.
    registerGetWeekNarrative(mcpServer, ddb, allowedContext('hh-1'), () => new Date(Date.UTC(2026, 8, 16)));
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'get_week_narrative', arguments: { isoWeek: '2026-W38' } });
    expect((result.content as { type: string; text: string }[])[0]!.text).toBe(WEEK_NOT_WRITTEN_TEXT);
  });

  it('returns the narrative JSON once residentSeenAt is set', async () => {
    const ddb = {
      send: vi.fn().mockResolvedValue({ Item: { data: { S: JSON.stringify(NARRATIVE) } } }),
    } as unknown as DynamoDBClient;

    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerGetWeekNarrative(mcpServer, ddb, allowedContext('hh-1'));

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'get_week_narrative', arguments: { isoWeek: '2026-W38' } });
    const content = result.content as { type: string; text: string }[];
    const parsed = JSON.parse(content[0]!.text) as WeekNarrative;

    expect(parsed).toEqual(NARRATIVE);
  });
});

describe('a week stored before the door and a confirmed visit were told apart', () => {
  const legacy: WeekNarrative = {
    householdId: 'hh-1',
    isoWeek: '2026-W40',
    text: 'Someone came to the front door twice. Maria visited twice.',
    textSource: 'model',
    deltas: [],
    timeline: [
      { at: Date.parse('2026-09-29T09:00:00Z'), kind: 'door', summary: 'Someone was at the front door.' },
      { at: Date.parse('2026-09-29T09:00:00Z'), kind: 'visit', summary: 'Maria visited.', personId: 'maria' },
      { at: Date.parse('2026-10-01T09:00:00Z'), kind: 'door', summary: 'Someone was at the front door.' },
      { at: Date.parse('2026-10-01T09:00:00Z'), kind: 'visit', summary: 'Maria visited.', personId: 'maria' },
    ],
    generatedAt: Date.parse('2026-10-04T20:00:00Z'),
    residentSeenAt: Date.parse('2026-10-04T20:05:00Z'),
  };

  it('reads its "Maria visited." entries as somebody at the door when she was expected', () => {
    const { narrative, upgraded } = upgradeLegacyWeek(legacy);
    expect(upgraded).toBe(true);
    expect(narrative.timeline.filter((e) => e.kind !== 'door')).toEqual([
      { at: Date.parse('2026-09-29T09:00:00Z'), kind: 'presence', summary: 'Someone came to the door when Maria was expected.', personId: 'maria', name: 'Maria' },
      { at: Date.parse('2026-10-01T09:00:00Z'), kind: 'presence', summary: 'Someone came to the door when Maria was expected.', personId: 'maria', name: 'Maria' },
    ]);
  });

  it('gives the family its text again from the facts, so the model’s "Maria visited twice" is never read', () => {
    const result = familyWeek(legacy, DEFAULT_POLICY, 'Europe/London');
    if (result.status !== 'available') throw new Error('expected a week');
    expect(result.narrative.textSource).toBe('facts');
    expect(result.narrative.text).toBe('Someone came to the front door twice this week: once on Tuesday morning and once on Thursday morning. Someone came to the door twice when Maria was expected.');
    expect(result.narrative.text).not.toMatch(/Maria visited/);
  });

  it('leaves a week in today’s words exactly as it was', () => {
    const current: WeekNarrative = { ...legacy, text: 'Someone came to the front door twice. Someone came to the door twice when Maria was expected.', timeline: upgradeLegacyWeek(legacy).narrative.timeline };
    expect(upgradeLegacyWeek(current)).toEqual({ narrative: current, upgraded: false });
    expect(familyWeek(current, DEFAULT_POLICY, 'Europe/London')).toEqual({ status: 'available', narrative: current });
  });
});

describe('familyWeek — Sarah’s copy honours what Margaret keeps private ("What Sarah sees")', () => {
  // 2026-W40: two door visits on Wednesday evening (London), and Maria on Tuesday.
  const WEEK: WeekNarrative = {
    householdId: 'hh-1',
    isoWeek: '2026-W40',
    text: 'Someone came to the front door twice, and Maria visited once.',
    textSource: 'model',
    deltas: [],
    timeline: [
      { at: Date.parse('2026-09-29T09:00:00Z'), kind: 'presence', summary: 'Someone came to the door when Maria was expected.', personId: 'maria', name: 'Maria' },
      { at: Date.parse('2026-09-30T18:10:00Z'), kind: 'door', summary: 'Someone was at the front door.' },
      { at: Date.parse('2026-09-30T18:40:00Z'), kind: 'door', summary: 'Someone was at the front door.' },
    ],
    generatedAt: Date.parse('2026-10-05T20:00:00Z'),
    residentSeenAt: Date.parse('2026-10-05T21:00:00Z'),
  };
  const policy = (residentExclusions: FactClass[]) => ({ ...DEFAULT_POLICY, residentExclusions });

  it('is the week as written when nothing is kept private', () => {
    expect(familyWeek(WEEK, policy([]), 'Europe/London')).toEqual({ status: 'available', narrative: WEEK });
  });

  it('drops who visited, and rewrites the prose from the facts that are still shared', () => {
    const result = familyWeek(WEEK, policy(['PRESENCE']), 'Europe/London');
    if (result.status !== 'available') throw new Error('expected available');
    expect(result.narrative.timeline.map((e) => e.kind)).toEqual(['door', 'door']);
    expect(result.narrative.text).toBe('Someone came to the front door twice this week, on Wednesday evening. Some of this week is kept private.');
    expect(result.narrative.text).not.toContain('Maria');
    expect(result.narrative.textSource).toBe('facts');
  });

  it('drops the door, without ever saying nobody came', () => {
    const result = familyWeek(WEEK, policy(['DOOR_EVENT']), 'Europe/London');
    if (result.status !== 'available') throw new Error('expected available');
    expect(result.narrative.timeline.map((e) => e.kind)).toEqual(['presence']);
    expect(result.narrative.text).toBe('Someone came once when Maria was expected. Some of this week is kept private.');
  });

  it('withholds the whole week when the resident keeps the summary of their week private', () => {
    expect(familyWeek(WEEK, policy(['RHYTHM']), 'Europe/London')).toEqual({ status: 'private' });
  });

  describe('with a Rhythm baseline', () => {
    // A week the door was as usual, and Maria — who usually comes twice — did not come.
    const COMPARED: WeekNarrative = {
      ...WEEK,
      text: 'Someone came to the front door twice. Maria did not visit, and usually comes about twice a week.',
      timeline: WEEK.timeline.filter((e) => e.kind === 'door'),
      deltas: [
        { metric: 'door', label: 'the front door', thisWeek: 2, lastWeek: 2, baseline: 2, zScore: 0, baselineWeeks: 4, verdict: 'usual' },
        { metric: 'visit:maria', label: 'Maria', thisWeek: 0, lastWeek: 2, baseline: 2, zScore: -2, baselineWeeks: 4, verdict: 'fewer' },
      ],
    };

    it('hands the family the comparisons as written when nothing is kept private', () => {
      expect(familyWeek(COMPARED, policy([]), 'Europe/London')).toEqual({ status: 'available', narrative: COMPARED });
    });

    it('says nothing of a visitor who stayed away when visitors are kept private — an absence is still a fact about them', () => {
      const result = familyWeek(COMPARED, policy(['PRESENCE']), 'Europe/London');
      if (result.status !== 'available') throw new Error('expected available');

      expect(result.narrative.deltas.map((d) => d.metric)).toEqual(['door']);
      expect(JSON.stringify(result.narrative)).not.toContain('Maria');
      expect(result.narrative.text).toBe('Someone came to the front door twice this week, on Wednesday evening. Some of this week is kept private.');
    });

    it('keeps the door\'s comparison back with the door, and still says who did not come', () => {
      const result = familyWeek(COMPARED, policy(['DOOR_EVENT']), 'Europe/London');
      if (result.status !== 'available') throw new Error('expected available');

      expect(result.narrative.deltas.map((d) => d.metric)).toEqual(['visit:maria']);
      expect(result.narrative.text).toBe('Nobody came to the door when Maria was expected; usually someone does, about twice a week. Some of this week is kept private.');
    });
  });
});

describe('get_week_narrative honours "What Sarah sees" (end to end through the registered tool)', () => {
  const callWith = async (exclusions: string[]) => {
    const ddb = {
      send: vi.fn(async (cmd: { input: { Key: { sk: { S: string } } } }) =>
        cmd.input.Key.sk.S === 'META'
          ? { Item: exclusions.length ? { residentExclusions: { SS: exclusions } } : undefined }
          : { Item: { data: { S: JSON.stringify(NARRATIVE) } } },
      ),
    } as unknown as DynamoDBClient;
    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerGetWeekNarrative(mcpServer, ddb, allowedContext('hh-1'));
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'get_week_narrative', arguments: { isoWeek: '2026-W38' } });
    return (result.content as { type: string; text: string }[])[0]!.text;
  };

  it('declines, warmly, when the resident keeps their week to themselves — and leaks nothing of it', async () => {
    const text = await callWith(['RHYTHM']);
    expect(text).toBe("That's something the resident is keeping to themselves. I'm not able to share it.");
    expect(text).not.toContain('Maria');
  });

  it('leaves out the visitors when the resident keeps them private', async () => {
    const week = JSON.parse(await callWith(['PRESENCE'])) as WeekNarrative;
    expect(week.timeline).toEqual([]);
    expect(week.text).not.toContain('Maria');
  });
});

describe('latestReadableWeek — "how has the week been?" has an answer on a Wednesday', () => {
  const week = (isoWeek: string, seen: boolean): WeekNarrative => {
    const { residentSeenAt, ...unread } = NARRATIVE;
    return { ...unread, isoWeek, text: `The story of ${isoWeek}.`, ...(seen ? { residentSeenAt } : {}) };
  };

  it('is this week, once it is written and the resident has read it', () => {
    expect(latestReadableWeek([week('2026-W38', true), week('2026-W37', true)], '2026-W38')).toEqual({
      status: 'available',
      narrative: week('2026-W38', true),
    });
  });

  it('is last week, saying this week is not written yet, for the six days before Sunday evening', () => {
    expect(latestReadableWeek([week('2026-W37', true), week('2026-W36', true)], '2026-W38')).toEqual({
      status: 'available',
      narrative: week('2026-W37', true),
      thisWeek: 'not_written',
    });
  });

  it('never hands over a week the resident has not read: it goes back to one they have (INV-7)', () => {
    expect(latestReadableWeek([week('2026-W38', false), week('2026-W37', true)], '2026-W38')).toEqual({
      status: 'available',
      narrative: week('2026-W37', true),
      thisWeek: 'awaiting_resident',
    });
  });

  it('skips an older week nobody read on the television, too', () => {
    expect(latestReadableWeek([week('2026-W37', false), week('2026-W36', true)], '2026-W38')).toMatchObject({
      narrative: { isoWeek: '2026-W36' },
      thisWeek: 'not_written',
    });
  });

  it('says a week is waiting on the television when none has been read yet', () => {
    expect(latestReadableWeek([week('2026-W38', false)], '2026-W38')).toEqual({ status: 'awaiting_resident' });
    expect(latestReadableWeek([week('2026-W37', false)], '2026-W38')).toEqual({ status: 'awaiting_resident' });
  });

  it('says nothing is written for a home with no weeks at all', () => {
    expect(latestReadableWeek([], '2026-W38')).toEqual({ status: 'not_written' });
  });
});

describe('get_week_narrative with no week named (end to end through the registered tool)', () => {
  const NOW = new Date(Date.UTC(2026, 8, 16, 12)); // Wednesday of 2026-W38
  const stored = (isoWeek: string, seen: boolean): { data: { S: string } } => ({
    data: { S: JSON.stringify({ ...NARRATIVE, isoWeek, text: `The story of ${isoWeek}.`, residentSeenAt: seen ? 200 : undefined }) },
  });

  const call = async (weeks: { data: { S: string } }[], args: Record<string, string> = {}) => {
    const send = vi.fn(async (cmd: { input: { Key?: { sk: { S: string } }; KeyConditionExpression?: string } }) =>
      cmd.input.KeyConditionExpression ? { Items: weeks } : { Item: undefined },
    );
    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerGetWeekNarrative(mcpServer, { send } as unknown as DynamoDBClient, allowedContext('hh-1'), () => NOW);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'get_week_narrative', arguments: args });
    return { text: (result.content as { type: string; text: string }[])[0]!.text, send };
  };

  it('asks for the newest weeks up to this one, newest first, in one query', async () => {
    const { send } = await call([stored('2026-W37', true)]);

    const query = send.mock.calls.map(([cmd]) => cmd.input).find((input) => input.KeyConditionExpression) as unknown as {
      ExpressionAttributeValues: Record<string, { S: string }>;
      ScanIndexForward: boolean;
    };
    expect(query.ExpressionAttributeValues).toMatchObject({ ':pk': { S: 'HH#hh-1' }, ':to': { S: 'NARR#2026-W38' } });
    expect(query.ScanIndexForward).toBe(false);
  });

  it('answers with last week, and says this week is not written yet', async () => {
    const { text } = await call([stored('2026-W37', true), stored('2026-W36', true)]);

    expect(JSON.parse(text)).toMatchObject({ isoWeek: '2026-W37', text: 'The story of 2026-W37.', thisWeek: 'not_written' });
  });

  it('keeps this week back until the resident has read it, and still answers with the one before', async () => {
    const { text } = await call([stored('2026-W38', false), stored('2026-W37', true)]);

    expect(text).not.toContain('The story of 2026-W38.');
    expect(JSON.parse(text)).toMatchObject({ isoWeek: '2026-W37', thisWeek: 'awaiting_resident' });
  });

  it('says an earlier week as "that week": its own "this week" would contradict "here is the week of …"', async () => {
    const said = { data: { S: JSON.stringify({
      ...NARRATIVE,
      isoWeek: '2026-W37',
      text: 'Someone came to the front door 6 times this week. That is one fewer than last week.',
      suggestion: { action: 'watch_together', reason: 'A film was played on the television this week.' },
    }) } };
    const { text } = await call([said]);

    expect(JSON.parse(text)).toMatchObject({
      isoWeek: '2026-W37',
      thisWeek: 'not_written',
      text: 'Someone came to the front door 6 times that week. That is one fewer than the week before.',
      suggestion: { action: 'watch_together', reason: 'A film was played on the television that week.' },
    });
  });

  it('keeps "this week" when the week returned is this one', async () => {
    const own = { data: { S: JSON.stringify({ ...NARRATIVE, isoWeek: '2026-W38', text: 'Someone came to the front door 6 times this week.' }) } };
    const { text } = await call([own]);

    expect(JSON.parse(text).text).toBe('Someone came to the front door 6 times this week.');
  });

  it('adds nothing to this week when it is the one returned', async () => {
    const { text } = await call([stored('2026-W38', true), stored('2026-W37', true)]);

    expect(JSON.parse(text)).toMatchObject({ isoWeek: '2026-W38' });
    expect(JSON.parse(text)).not.toHaveProperty('thisWeek');
  });

  it('says a week is waiting on the television, or that none is written, when there is nothing to read', async () => {
    expect((await call([stored('2026-W38', false)])).text).toBe(WEEK_AWAITING_RESIDENT_TEXT);
    expect((await call([])).text).toBe(WEEK_NOT_WRITTEN_TEXT);
  });

  it('answers for exactly the week that was named, and does not call a past week "this week"', async () => {
    const { text, send } = await call([stored('2026-W37', true)], { isoWeek: '2026-W30' });

    expect(text).toBe(WEEK_NOT_WRITTEN_THEN_TEXT);
    expect(send.mock.calls.some(([cmd]) => cmd.input.KeyConditionExpression)).toBe(false);
  });
});

describe('the Sunday brief’s suggestion — read by the family under the same gate as the week (INV-7)', () => {
  const AGENTS_WEEK: WeekNarrative = {
    ...NARRATIVE,
    text: 'A quiet week at the door.',
    textSource: 'agents',
    suggestion: { action: 'send_note', reason: 'A quiet week: a note would be nice to come back to.' },
  };
  const register = async (week: WeekNarrative, exclusions: string[] = []) => {
    const ddb = {
      send: vi.fn(async (cmd: { input: { Key: { sk: { S: string } } } }) =>
        cmd.input.Key.sk.S === 'META'
          ? { Item: exclusions.length ? { residentExclusions: { SS: exclusions } } : undefined }
          : { Item: { data: { S: JSON.stringify(week) } } },
      ),
    } as unknown as DynamoDBClient;
    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerGetWeekNarrative(mcpServer, ddb, allowedContext('hh-1'));
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'get_week_narrative', arguments: { isoWeek: '2026-W38' } });
    return { result, text: (result.content as { type: string; text: string }[])[0]!.text };
  };

  it('returns the suggestion, and that the agents wrote the week, once she has read it', async () => {
    const { result, text } = await register(AGENTS_WEEK);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text)).toMatchObject({ textSource: 'agents', suggestion: AGENTS_WEEK.suggestion });
    expect(result.structuredContent).toMatchObject({ suggestion: AGENTS_WEEK.suggestion });
  });

  it('withholds the suggestion with the week while she has not read it', async () => {
    const { residentSeenAt: _unread, ...unseen } = AGENTS_WEEK;
    const { text } = await register(unseen);
    expect(text).toBe(WEEK_AWAITING_RESIDENT_TEXT);
    expect(text).not.toContain(AGENTS_WEEK.suggestion!.reason);
  });

  it('drops the suggestion when the family’s copy is rewritten for what she keeps private: it rested on facts they may not read', () => {
    const week: WeekNarrative = {
      ...AGENTS_WEEK,
      timeline: [{ at: Date.parse('2026-09-15T09:00:00Z'), kind: 'presence', summary: 'Someone came to the door when Maria was expected.', personId: 'maria', name: 'Maria' }],
      suggestion: { action: 'arrange_visit', reason: 'Maria came only once this week.' },
    };
    const family = familyWeek(week, { ...DEFAULT_POLICY, residentExclusions: ['PRESENCE'] }, 'Europe/London');
    expect(family.status).toBe('available');
    expect(family.status === 'available' && family.narrative.suggestion).toBeUndefined();
  });

  it('drops a suggestion the Guardian will not let the family read, and keeps the week', () => {
    const week: WeekNarrative = { ...AGENTS_WEEK, suggestion: { action: 'send_note', reason: 'Ask how her new medication is going.' } };
    const family = familyWeek(week, DEFAULT_POLICY, 'Europe/London');
    const { suggestion: _withheld, ...withoutIt } = week;
    expect(family).toEqual({ status: 'available', narrative: withoutIt });
  });

  it('keeps the suggestion with the week as written when nothing is kept private', () => {
    expect(familyWeek(AGENTS_WEEK, DEFAULT_POLICY, 'Europe/London')).toEqual({ status: 'available', narrative: AGENTS_WEEK });
  });
});

describe('spokenFromThen — a week\'s words about itself, once it is over', () => {
  it('turns this, last and next week into that week, the week before and the week after, keeping a capital', () => {
    expect(spokenFromThen('This week was quiet. More than last week, and next week Maria is away.')).toBe(
      'That week was quiet. More than the week before, and the week after Maria is away.',
    );
  });

  it('changes no number, name or other word', () => {
    expect(spokenFromThen('Maria visited twice, as she usually does, and this weekend was quiet.')).toBe(
      'Maria visited twice, as she usually does, and this weekend was quiet.',
    );
    expect(spokenFromThen('6 times so far this week.')).toBe('6 times that week.');
  });
});
