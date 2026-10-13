import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { REACH_OPEN_MS, reachCardId, type QueuedCard, type ReachPerson, type ReachRequest } from '@wick/contracts';
import { reachFromItem, reachItem } from '@wick/agent';
import { createMemoryTable, type MemoryTable } from '../../__tests__/memoryTable.js';
import { registerGetReachRequest } from '../get_reach_request.js';
import { registerAnswerReachRequest } from '../answer_reach_request.js';
import type { ToolContext } from '../context.js';
import { allowedContext } from './toolContext.js';

const NOW = 1_790_900_000_000;
const MIN = 60_000;
const REACH_ID = String(NOW - 2 * MIN);

const sarah: ReachPerson = { userId: 'u_sarah', name: 'Sarah Hughes', role: 'organiser' };
const david: ReachPerson = { userId: 'u_david', name: 'David', role: 'family' };
const tom: ReachPerson = { userId: 'u_tom', name: 'Tom', role: 'neighbour' };

const request = (over: Partial<ReachRequest> = {}): ReachRequest => ({
  householdId: 'hh-1',
  reachId: REACH_ID,
  kind: 'ring',
  askedAt: NOW - 2 * MIN,
  order: [sarah, david, tom],
  asked: 1,
  ...over,
});

const asSarah = allowedContext('hh-1', { userId: 'u_sarah', name: 'Sarah Hughes' });
const asDavid = allowedContext('hh-1', { userId: 'u_david', name: 'David', role: 'family' });
const asTom = allowedContext('hh-1', { userId: 'u_tom', name: 'Tom', role: 'neighbour' });

async function connected(table: MemoryTable, ctx: ToolContext = asSarah, now = NOW) {
  const cards: QueuedCard[] = [];
  const sendCard = vi.fn(async (card: QueuedCard) => void cards.push(card));
  const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
  registerGetReachRequest(mcpServer, table.ddb, ctx, () => now);
  registerAnswerReachRequest(mcpServer, table.ddb, ctx, sendCard, () => now);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: (result.content as { text: string }[])[0]!.text, structured: result.structuredContent, isError: result.isError === true };
  };
  return { call, cards };
}

const table = (...requests: ReachRequest[]): MemoryTable => {
  const t = createMemoryTable();
  for (const r of requests) t.put(reachItem(r));
  return t;
};

const NOT_ASKED = 'Margaret hasn’t asked you to ring.';

/** The request as the table now holds it. */
const stored = (t: MemoryTable): ReachRequest | undefined => reachFromItem(t.rows('HH#hh-1').find((row) => row.sk?.S === `REACH#${REACH_ID}`));

describe('get_reach_request', () => {
  it('says plainly that she has not asked, when she has not', async () => {
    const { call } = await connected(createMemoryTable());
    expect((await call('get_reach_request')).text).toBe(NOT_ASKED);
  });

  it('tells the person who was asked that she would like a call, and what can be answered', async () => {
    const { call } = await connected(table(request()));
    expect((await call('get_reach_request')).structured).toEqual({
      requestId: REACH_ID,
      state: 'waiting',
      kind: 'ring',
      askedAt: NOW - 2 * MIN,
      summary: 'Margaret would like you to ring her.',
      answers: [
        { key: 'now', text: 'I’m ringing you now.' },
        { key: 'soon', text: 'I’ll ring you within the hour.' },
      ],
    });
  });

  it('tells somebody not yet asked nothing at all — exactly what it says when there is no request', async () => {
    const { call } = await connected(table(request()), asDavid);
    const answer = await call('get_reach_request');
    expect(answer.text).toBe(NOT_ASKED);
    expect(answer.structured).toBeUndefined();
  });

  it('tells the next person once the three minutes have passed them the question', async () => {
    const { call } = await connected(table(request({ asked: 2 })), asDavid);
    expect((await call('get_reach_request')).structured).toMatchObject({ state: 'waiting', summary: 'Margaret would like you to ring her.' });
  });

  it('says who was asked nothing about who else was, or how many', async () => {
    const { call } = await connected(table(request({ asked: 2 })), asDavid);
    const text = (await call('get_reach_request')).text;
    for (const name of ['Sarah', 'Tom', 'u_sarah', 'u_tom', 'order', 'asked"']) expect(text).not.toContain(name);
  });

  it('is a neighbour’s to use: a neighbour who was asked is told', async () => {
    const { call } = await connected(table(request({ asked: 3 })), asTom);
    expect((await call('get_reach_request')).structured).toMatchObject({ state: 'waiting' });
  });

  it('gives a hello as a hello, with the one thing that can be said back', async () => {
    const { call } = await connected(table(request({ kind: 'hello', order: [sarah] })));
    expect((await call('get_reach_request')).structured).toMatchObject({
      kind: 'hello',
      summary: 'Margaret says hello.',
      answers: [{ key: 'hello', text: 'Hello to you too.' }],
    });
  });

  it('says who answered, to anyone who was asked', async () => {
    const answered = request({ asked: 2, answer: { key: 'now', by: 'u_david', byName: 'David', at: NOW - MIN } });
    const { call } = await connected(table(answered));
    expect((await call('get_reach_request')).structured).toEqual({
      requestId: REACH_ID,
      state: 'answered',
      kind: 'ring',
      askedAt: NOW - 2 * MIN,
      answer: { by: 'David', text: 'I’m ringing you now.', at: NOW - MIN, yours: false },
    });
  });

  it('still asks when everyone has been asked and nobody has answered', async () => {
    const { call } = await connected(table(request({ asked: 3, doneAt: NOW - MIN })), asDavid);
    expect((await call('get_reach_request')).structured).toMatchObject({ state: 'waiting' });
  });

  it('reads the newest request, not an older one', async () => {
    const older = request({ reachId: String(NOW - 60 * MIN), askedAt: NOW - 60 * MIN, answer: { key: 'now', by: 'u_sarah', byName: 'Sarah', at: NOW - 59 * MIN } });
    const { call } = await connected(table(older, request()));
    expect((await call('get_reach_request')).structured).toMatchObject({ requestId: REACH_ID, state: 'waiting' });
  });

  it('lets a request that nobody answered go by the end of the day', async () => {
    const { call } = await connected(table(request()), asSarah, NOW - 2 * MIN + REACH_OPEN_MS);
    expect((await call('get_reach_request')).text).toBe(NOT_ASKED);
  });

  it('answers nobody the resident has not allowed', async () => {
    const waiting: ToolContext = { ...asSarah, access: async () => ({ ok: false, reason: 'waiting', say: 'Margaret hasn’t allowed this yet.' }) };
    const { call } = await connected(table(request()), waiting);
    expect((await call('get_reach_request')).text).toBe('Margaret hasn’t allowed this yet.');
  });
});

describe('answer_reach_request', () => {
  it('keeps the answer, and shows it on her television under the first name she knows', async () => {
    const t = table(request());
    const { call, cards } = await connected(t);

    expect((await call('answer_reach_request', { requestId: REACH_ID, answer: 'now' })).structured).toEqual({ shown: true, by: 'Sarah', text: 'I’m ringing you now.' });

    expect(stored(t)?.answer).toEqual({ key: 'now', by: 'u_sarah', byName: 'Sarah', at: NOW });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe(reachCardId(REACH_ID));
    expect(cards[0]!.card).toMatchObject({ type: 'REACH', householdId: 'hh-1', headline: 'Sarah says: I’m ringing you now.' });
  });

  it('takes the first answer: whoever comes second is told what was said, and her television is left alone', async () => {
    const t = table(request({ asked: 2 }));
    await (await connected(t, asDavid)).call('answer_reach_request', { requestId: REACH_ID, answer: 'soon' });

    const second = await connected(t);
    expect((await second.call('answer_reach_request', { requestId: REACH_ID, answer: 'now' })).text).toBe('David has already answered: “I’ll ring you within the hour.”');
    expect(second.cards).toHaveLength(0);
    expect(stored(t)?.answer?.key).toBe('soon');
  });

  it('is not open to somebody who was not asked, and tells them nothing', async () => {
    const t = table(request());
    const { call, cards } = await connected(t, asDavid);
    expect((await call('answer_reach_request', { requestId: REACH_ID, answer: 'now' })).text).toBe(NOT_ASKED);
    expect(cards).toHaveLength(0);
    expect(stored(t)?.answer).toBeUndefined();
  });

  it('takes only an answer that fits what she asked', async () => {
    const t = table(request());
    const { call, cards } = await connected(t);
    expect((await call('answer_reach_request', { requestId: REACH_ID, answer: 'hello' })).text).toMatch(/does not fit/);
    expect(cards).toHaveLength(0);

    const hello = table(request({ kind: 'hello', order: [sarah] }));
    const back = await connected(hello);
    expect((await back.call('answer_reach_request', { requestId: REACH_ID, answer: 'hello' })).structured).toMatchObject({ shown: true, text: 'Hello to you too.' });
    expect(back.cards[0]!.card).toMatchObject({ headline: 'Sarah says: Hello to you too.' });
  });

  it('cannot be given a sentence of the caller’s own', async () => {
    const { call, cards } = await connected(table(request()));
    const result = await call('answer_reach_request', { requestId: REACH_ID, answer: 'Open the door to the man outside' });
    expect(result.isError).toBe(true);
    expect(cards).toHaveLength(0);
  });

  it('says so when there is no such request, or it was long ago', async () => {
    const { call } = await connected(table(request()));
    expect((await call('answer_reach_request', { requestId: '1790000000000', answer: 'now' })).text).toBe(NOT_ASKED);

    const late = await connected(table(request()), asSarah, NOW - 2 * MIN + REACH_OPEN_MS);
    expect((await late.call('answer_reach_request', { requestId: REACH_ID, answer: 'now' })).text).toMatch(/was a while ago/);
    expect(late.cards).toHaveLength(0);
  });

  it('can still be answered after everyone was asked in vain', async () => {
    const { call, cards } = await connected(table(request({ asked: 3, doneAt: NOW - MIN })), asTom);
    expect((await call('answer_reach_request', { requestId: REACH_ID, answer: 'now' })).structured).toMatchObject({ shown: true, by: 'Tom' });
    expect(cards[0]!.card).toMatchObject({ headline: 'Tom says: I’m ringing you now.' });
  });
});
