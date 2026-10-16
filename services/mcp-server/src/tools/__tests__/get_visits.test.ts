import { describe, expect, it } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DEFAULT_POLICY } from '@wick/policy';
import type { Visit } from '@wick/contracts';
import { visitItem } from '@wick/agent';
import { createMemoryTable, type MemoryTable } from '../../__tests__/memoryTable.js';
import { registerGetVisits } from '../get_visits.js';
import { FAMILY_REFUSAL_TEXT } from '../get_resident_shared_view.js';
import type { ToolContext } from '../context.js';
import { allowedContext } from './toolContext.js';

const MIN = 60_000;
const DAY = 86_400_000;
// Wednesday 14 October 2026, 16:00 in London (British Summer Time): 15:00 UTC.
const NOW = Date.UTC(2026, 9, 14, 15);
/** 9:02 in the morning in London, on a day of October 2026. */
const morning = (day: number, minute = 2): number => Date.UTC(2026, 9, day, 8, minute);

const visit = (over: Partial<Visit> = {}): Visit => ({
  householdId: 'hh-1',
  personId: 'maria',
  name: 'Maria',
  arrivedAt: morning(13),
  leftAt: morning(13, 47),
  ...over,
});
const confirmed = (over: Partial<Visit> = {}): Visit => {
  const v = visit(over);
  const asked = (v.leftAt ?? v.arrivedAt) + 20 * MIN;
  return { ...v, askedAt: asked, answer: 'confirmed', answeredAt: asked + MIN };
};

const asSarah = allowedContext('hh-1', { userId: 'u_sarah', name: 'Sarah Hughes' });
const asTom = allowedContext('hh-1', { userId: 'u_tom', name: 'Tom', role: 'neighbour' });

async function connected(table: MemoryTable, ctx: ToolContext = asSarah, now = NOW, ddb: DynamoDBClient = table.ddb) {
  const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
  registerGetVisits(mcpServer, ddb, ctx, () => now);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  return async (args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: 'get_visits', arguments: args });
    return {
      text: (result.content as { text: string }[])[0]!.text,
      structured: result.structuredContent as Record<string, unknown> | undefined,
      isError: result.isError === true,
    };
  };
}

const table = (...visits: Visit[]): MemoryTable => {
  const t = createMemoryTable();
  for (const v of visits) t.put(visitItem(v));
  return t;
};

const ask = async (visits: Visit[], args: Record<string, unknown> = {}) => (await connected(table(...visits)))(args);
const summaryOf = async (visits: Visit[], args: Record<string, unknown> = {}) => (await ask(visits, args)).structured!.summary;

describe('get_visits — did the carer come, and did she confirm it', () => {
  it('says so plainly when no visit has been noted', async () => {
    expect((await ask([])).structured).toEqual({
      days: 7,
      visits: [],
      confirmedCount: 0,
      residentName: 'Margaret',
      summary: 'No visits by a regular visitor have been noted in the last 7 days.',
    });
  });

  it('gives a visit she confirmed: who, the day, and the times the doorbell noted, as they were at the house', async () => {
    expect((await ask([confirmed()])).structured).toEqual({
      days: 7,
      visits: [{
        personId: 'maria',
        name: 'Maria',
        date: '2026-10-13',
        day: 'Tuesday',
        arrived: '9:02 am',
        left: '9:47 am',
        arrivedAt: morning(13),
        leftAt: morning(13, 47),
        confirmed: true,
      }],
      confirmedCount: 1,
      residentName: 'Margaret',
      summary: 'Maria came once in the last 7 days. Margaret has confirmed it.',
    });
  });

  it('says the same thing as text, for a client that only reads text', async () => {
    const answer = await ask([confirmed()]);

    expect(JSON.parse(answer.text)).toEqual(answer.structured);
  });

  it('names the day as it was at the house, not in UTC', async () => {
    // 23:30 UTC on Monday the 12th is half past midnight on Tuesday the 13th in London.
    const late = confirmed({ arrivedAt: Date.UTC(2026, 9, 12, 23, 30), leftAt: Date.UTC(2026, 9, 13, 0, 15) });

    expect((await ask([late])).structured!.visits).toEqual([
      expect.objectContaining({ date: '2026-10-13', day: 'Tuesday', arrived: '12:30 am', left: '1:15 am' }),
    ]);
  });

  it('gives only the arrival when nobody was seen leaving', async () => {
    const { leftAt: _leftAt, ...arrivalOnly } = confirmed();
    const [only] = (await ask([arrivalOnly])).structured!.visits as Record<string, unknown>[];

    expect(only).toEqual({ personId: 'maria', name: 'Maria', date: '2026-10-13', day: 'Tuesday', arrived: '9:02 am', arrivedAt: morning(13), confirmed: true });
  });

  it('lists the newest visit first', async () => {
    const visits = (await ask([confirmed({ arrivedAt: morning(9), leftAt: morning(9, 50) }), confirmed(), confirmed({ arrivedAt: morning(11), leftAt: morning(11, 40) })])).structured!.visits as { date: string }[];

    expect(visits.map((v) => v.date)).toEqual(['2026-10-13', '2026-10-11', '2026-10-09']);
  });
});

describe('get_visits — a visit is confirmed or it is not, and nothing else is said (INV-10’s reasoning)', () => {
  const unasked = visit();
  const askedAndWaiting = visit({ askedAt: morning(13, 59) });
  const disputed = visit({ askedAt: morning(13, 59), answer: 'disputed', answeredAt: morning(14, 3) });

  it('answers in exactly the same words for a visit she has not been asked about, one she has not answered, and one she said was not right', async () => {
    const answers = await Promise.all([unasked, askedAndWaiting, disputed].map((v) => ask([v])));

    expect(answers[0]!.structured!.visits).toEqual([expect.objectContaining({ confirmed: false })]);
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });

  it('gives the three the same entry when they are in one answer, apart from when they were', async () => {
    const visits = (await ask([
      { ...unasked, arrivedAt: morning(9), leftAt: morning(9, 47) },
      { ...askedAndWaiting, arrivedAt: morning(11), leftAt: morning(11, 47) },
      disputed,
    ])).structured!.visits as Record<string, unknown>[];
    const withoutTheDay = visits.map(({ date: _date, day: _day, arrivedAt: _arrivedAt, leftAt: _leftAt, ...rest }) => rest);

    expect(withoutTheDay).toHaveLength(3);
    expect(withoutTheDay[1]).toEqual(withoutTheDay[0]);
    expect(withoutTheDay[2]).toEqual(withoutTheDay[0]);
    expect(Object.keys(visits[0]!).sort()).toEqual(['arrived', 'arrivedAt', 'confirmed', 'date', 'day', 'left', 'leftAt', 'name', 'personId']);
  });

  it('never says, in any field or any word, that she was asked or what she answered', async () => {
    const { text } = await ask([
      { ...unasked, arrivedAt: morning(9), leftAt: morning(9, 47) },
      { ...askedAndWaiting, arrivedAt: morning(11), leftAt: morning(11, 47) },
      disputed,
      confirmed({ arrivedAt: morning(12), leftAt: morning(12, 47) }),
    ]);

    expect(text).not.toMatch(/answer|asked|disput|reject|waiting|said no|wrong|not right|forgot|refus|declin/i);
    expect(text).toContain('Maria came 4 times in the last 7 days. Margaret has confirmed 1 of them.');
  });

  it('counts only the visits she confirmed', async () => {
    expect((await ask([unasked, { ...disputed, arrivedAt: morning(11), leftAt: morning(11, 47) }, confirmed({ arrivedAt: morning(9), leftAt: morning(9, 47) })])).structured)
      .toMatchObject({ confirmedCount: 1 });
  });
});

describe('get_visits — the sentence to be said as it stands', () => {
  const on = (day: number, v: (over: Partial<Visit>) => Visit = confirmed, over: Partial<Visit> = {}): Visit => v({ arrivedAt: morning(day), leftAt: morning(day, 47), ...over });

  it('says once, twice, and then the number', async () => {
    expect(await summaryOf([on(13)])).toBe('Maria came once in the last 7 days. Margaret has confirmed it.');
    expect(await summaryOf([on(13), on(9)])).toBe('Maria came twice in the last 7 days. Margaret has confirmed both of them.');
    expect(await summaryOf([on(13), on(11), on(9)])).toBe('Maria came 3 times in the last 7 days. Margaret has confirmed all of them.');
  });

  it('says how many she has confirmed when it is some of them', async () => {
    expect(await summaryOf([on(13, visit), on(11), on(9)])).toBe('Maria came 3 times in the last 7 days. Margaret has confirmed 2 of them.');
    expect(await summaryOf([on(13, visit), on(9)])).toBe('Maria came twice in the last 7 days. Margaret has confirmed 1 of them.');
  });

  it('says only that she has not confirmed them yet when she has confirmed none — no reason, and no judgement', async () => {
    expect(await summaryOf([on(13, visit)])).toBe('Maria came once in the last 7 days. Margaret has not confirmed it yet.');
    expect(await summaryOf([on(13, visit), on(9, visit)])).toBe('Maria came twice in the last 7 days. Margaret has not confirmed either of them yet.');
    expect(await summaryOf([on(13, visit), on(11, visit), on(9, visit)])).toBe('Maria came 3 times in the last 7 days. Margaret has not confirmed any of them yet.');
  });

  it('counts visits rather than naming anyone when several regular visitors came', async () => {
    const joan = { personId: 'joan', name: 'Joan' };

    expect(await summaryOf([on(13), on(12, confirmed, joan), on(9, visit)])).toBe('3 visits by regular visitors were noted in the last 7 days. Margaret has confirmed 2 of them.');
    expect(await summaryOf([on(13), on(12, confirmed, joan)])).toBe('2 visits by regular visitors were noted in the last 7 days. Margaret has confirmed both of them.');
  });

  it('keeps to one visitor when one is named', async () => {
    const joan = { personId: 'joan', name: 'Joan' };
    const answer = await ask([on(13), on(12, confirmed, joan), on(9, visit)], { personId: 'maria' });

    expect((answer.structured!.visits as { personId: string }[]).map((v) => v.personId)).toEqual(['maria', 'maria']);
    expect(answer.structured).toMatchObject({ confirmedCount: 1, summary: 'Maria came twice in the last 7 days. Margaret has confirmed 1 of them.' });
  });

  it('does not say that nobody came when it was asked about one visitor and found none of theirs', async () => {
    expect(await summaryOf([on(13)], { personId: 'joan' })).toBe('No visits by that visitor have been noted in the last 7 days.');
  });
});

describe('get_visits — how far back', () => {
  const lastWeek = confirmed({ arrivedAt: morning(6), leftAt: morning(6, 47) });

  it('reads the last seven days unless told otherwise', async () => {
    const answer = await ask([confirmed(), lastWeek]);

    expect(answer.structured).toMatchObject({ days: 7, confirmedCount: 1 });
  });

  it('reads as many days as it is asked for, and says how many', async () => {
    expect((await ask([confirmed(), lastWeek], { days: 14 })).structured).toMatchObject({
      days: 14,
      confirmedCount: 2,
      summary: 'Maria came twice in the last 14 days. Margaret has confirmed both of them.',
    });
    expect(await summaryOf([], { days: 1 })).toBe('No visits by a regular visitor have been noted in the last day.');
  });

  it('counts back from now, to the minute', async () => {
    const justInside = confirmed({ arrivedAt: NOW - 7 * DAY, leftAt: NOW - 7 * DAY + 45 * MIN });
    const justOutside = confirmed({ arrivedAt: NOW - 7 * DAY - 1, leftAt: NOW - 7 * DAY + 45 * MIN });

    expect((await ask([justInside])).structured).toMatchObject({ confirmedCount: 1 });
    expect((await ask([justOutside])).structured).toMatchObject({ visits: [] });
  });

  it('refuses a number of days that is not a whole one from 1 to 31', async () => {
    const call = await connected(table(confirmed()));

    for (const days of [0, 32, 1.5, -7]) {
      const refused = await call({ days }).then((answer) => answer.isError, () => true);
      expect(refused, `days: ${days}`).toBe(true);
    }
  });
});

describe('get_visits — who it answers, and about which home', () => {
  it('withholds everything, and reads nothing, when she keeps who visits to herself', async () => {
    const t = table(confirmed());
    t.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'META' }, policy: { S: JSON.stringify({ ...DEFAULT_POLICY, residentExclusions: ['PRESENCE'] }) } });
    const sent: string[] = [];
    const watched = { send: async (command: { constructor: { name: string } }) => (sent.push(command.constructor.name), (t.ddb.send as (c: unknown) => Promise<unknown>)(command)) } as unknown as DynamoDBClient;

    const answer = await (await connected(t, asSarah, NOW, watched))();

    expect(answer.text).toBe(FAMILY_REFUSAL_TEXT);
    expect(answer.structured).toEqual({ say: answer.text });
    // The policy, and nothing after it: no visit was read.
    expect(sent).toEqual(['GetItemCommand']);
  });

  it('refuses a neighbour: a neighbour is asked two things, and shown nothing', async () => {
    const answer = await (await connected(table(confirmed()), asTom))();

    expect(answer.text).toBe('Margaret has asked you to help in two ways: to look at who is at the door, and to ring when asked. Nothing else about the house is shared with a neighbour.');
    expect(answer.structured).toEqual({ say: answer.text });
  });

  it('answers nobody the resident has not allowed', async () => {
    const waiting: ToolContext = { ...asSarah, access: async () => ({ ok: false, reason: 'waiting', say: 'Margaret hasn’t allowed this yet.' }) };

    expect((await (await connected(table(confirmed()), waiting))()).text).toBe('Margaret hasn’t allowed this yet.');
  });

  it('reads only the home the caller’s token is for (INV-8)', async () => {
    const answer = await ask([confirmed({ householdId: 'hh-2' })]);

    expect(answer.structured).toMatchObject({ visits: [], confirmedCount: 0 });
  });

  it('is not a look: asking it is not noted on her home screen', async () => {
    let looks = 0;
    const counting: ToolContext = { ...asSarah, lookedIn: async () => void (looks += 1) };

    await (await connected(table(confirmed()), counting))();

    expect(looks).toBe(0);
  });
});

describe('get_visits — a demo home', () => {
  it('says the answer is simulated when the visits are, once and for the whole answer', async () => {
    const answer = await ask([confirmed({ simulated: true }), visit({ arrivedAt: morning(9), leftAt: morning(9, 47), simulated: true })]);

    expect(answer.structured).toMatchObject({ simulated: true });
    for (const v of answer.structured!.visits as Record<string, unknown>[]) expect(v).not.toHaveProperty('simulated');
  });

  it('says nothing of the kind for a home somebody lives in', async () => {
    expect((await ask([confirmed()])).structured).not.toHaveProperty('simulated');
  });
});
