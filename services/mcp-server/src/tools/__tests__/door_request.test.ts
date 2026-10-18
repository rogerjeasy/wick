import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DOOR_ANSWERS, type CardPatch } from '@wick/contracts';
import { createMemoryTable, type MemoryTable } from '../../__tests__/memoryTable.js';
import { loadDoorRequest, registerGetDoorRequest } from '../get_door_request.js';
import { registerAnswerDoorRequest } from '../answer_door_request.js';
import type { ToolContext } from '../context.js';
import { allowedContext } from './toolContext.js';

const NOW = 1_790_900_000_000;
const MIN = 60_000;
const PICTURE = 'https://download.example/ring/frame.jpg?sig=abc';

/** A door card on the television, as egress.ts stores it. */
function putCard(table: MemoryTable, cardId: string, over: { description?: string; imageRef?: string; notice?: string } = {}, expiresAt = NOW + 4 * MIN): void {
  table.put({
    pk: { S: 'HH#hh-1' },
    sk: { S: `CARD#${cardId}` },
    data: {
      S: JSON.stringify({
        id: cardId,
        urgency: 'DOOR',
        queuedAt: NOW - MIN,
        expiresAt,
        shownCount: 0,
        card: { type: 'DOOR', id: cardId, householdId: 'hh-1', line: "Someone's at the front door.", actions: [], ...over },
      }),
    },
  });
}

/** The row askFamily.ts writes when the resident presses the button. */
function putLook(table: MemoryTable, cardId: string, askedAt: number, over: Record<string, { S: string } | { N: string }> = {}): void {
  table.put({
    pk: { S: 'HH#hh-1' },
    sk: { S: `LOOK#${cardId}` },
    cardId: { S: cardId },
    askedAt: { N: String(askedAt) },
    expiresAt: { N: String(askedAt + 4 * MIN) },
    ttl: { N: String(Math.floor(askedAt / 1000) + 86_400) },
    ...over,
  });
}

const ANSWERS = Object.entries(DOOR_ANSWERS).map(([key, text]) => ({ key, text }));

describe('loadDoorRequest', () => {
  it('is nothing when nobody has been asked', async () => {
    expect(await loadDoorRequest(createMemoryTable().ddb, 'hh-1', NOW)).toBeUndefined();
  });

  it('is the picture, the sentence and the answers on offer while the door card is still on the television', async () => {
    const table = createMemoryTable();
    putCard(table, 'door-abc', { description: 'A man in a yellow jacket holding a clipboard.', imageRef: PICTURE });
    putLook(table, 'door-abc', NOW - 30_000);

    expect(await loadDoorRequest(table.ddb, 'hh-1', NOW)).toEqual({
      requestId: 'door-abc',
      state: 'waiting',
      askedAt: NOW - 30_000,
      line: "Someone's at the front door.",
      description: 'A man in a yellow jacket holding a clipboard.',
      pictureUrl: PICTURE,
      answers: ANSWERS,
    });
  });

  it('is still a question when the picture and the sentence have not arrived yet', async () => {
    const table = createMemoryTable();
    putCard(table, 'door-abc');
    putLook(table, 'door-abc', NOW - 1_000);

    const request = await loadDoorRequest(table.ddb, 'hh-1', NOW);

    expect(request).toMatchObject({ state: 'waiting', line: "Someone's at the front door." });
    expect(request).not.toHaveProperty('pictureUrl');
    expect(request).not.toHaveProperty('description');
  });

  it('is the newest question when the door has been asked about more than once', async () => {
    const table = createMemoryTable();
    putCard(table, 'door-old');
    putCard(table, 'door-new');
    putLook(table, 'door-old', NOW - 3 * MIN);
    putLook(table, 'door-new', NOW - MIN);

    expect((await loadDoorRequest(table.ddb, 'hh-1', NOW))?.requestId).toBe('door-new');
  });

  it('says who answered and what, and no longer hands out the picture', async () => {
    const table = createMemoryTable();
    putCard(table, 'door-abc', { imageRef: PICTURE });
    putLook(table, 'door-abc', NOW - MIN, { answerKey: { S: 'dont_open' }, answeredAt: { N: String(NOW - 20_000) }, answeredByName: { S: 'Sarah' } });

    expect(await loadDoorRequest(table.ddb, 'hh-1', NOW)).toEqual({
      requestId: 'door-abc',
      state: 'answered',
      askedAt: NOW - MIN,
      answer: { by: 'Sarah', text: DOOR_ANSWERS.dont_open, at: NOW - 20_000 },
    });
  });

  it('has gone once the door card has left the television — by its clock, or because the card is no longer there', async () => {
    const expired = createMemoryTable();
    putCard(expired, 'door-abc', { imageRef: PICTURE }, NOW - 1);
    putLook(expired, 'door-abc', NOW - 10 * MIN);
    const cardless = createMemoryTable();
    putLook(cardless, 'door-abc', NOW - MIN);

    expect(await loadDoorRequest(expired.ddb, 'hh-1', NOW)).toEqual({ requestId: 'door-abc', state: 'gone', askedAt: NOW - 10 * MIN });
    expect(await loadDoorRequest(cardless.ddb, 'hh-1', NOW)).toEqual({ requestId: 'door-abc', state: 'gone', askedAt: NOW - MIN });
  });
});

async function connected(table: MemoryTable, ctx: ToolContext = allowedContext('hh-1')) {
  const patches: { patch: CardPatch; householdId: string }[] = [];
  const sendPatch = vi.fn(async (patch: CardPatch, householdId: string) => void patches.push({ patch, householdId }));
  const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
  registerGetDoorRequest(mcpServer, table.ddb, ctx, () => NOW);
  registerAnswerDoorRequest(mcpServer, table.ddb, ctx, sendPatch, () => NOW);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: (result.content as { text: string }[])[0]!.text, structured: result.structuredContent, isError: result.isError === true };
  };
  return { call, patches };
}

describe('get_door_request (through the registered tool)', () => {
  it('says plainly that nobody has asked', async () => {
    const { call } = await connected(createMemoryTable());

    expect((await call('get_door_request')).text).toBe("Margaret hasn't asked anyone to look at the door.");
  });

  it('hands a waiting question over as something a card can be drawn from', async () => {
    const table = createMemoryTable();
    putCard(table, 'door-abc', { description: 'A man in a yellow jacket.', imageRef: PICTURE });
    putLook(table, 'door-abc', NOW - 30_000);
    const { call } = await connected(table);

    expect((await call('get_door_request')).structured).toMatchObject({ requestId: 'door-abc', state: 'waiting', pictureUrl: PICTURE, answers: ANSWERS });
  });

  it('answers nobody the resident has not allowed', async () => {
    const table = createMemoryTable();
    putCard(table, 'door-abc', { imageRef: PICTURE });
    putLook(table, 'door-abc', NOW - 30_000);
    const waiting: ToolContext = { householdId: 'hh-1', userId: 'u_new', access: async () => ({ ok: false, reason: 'waiting', say: "Margaret hasn't allowed this yet." }) };
    const { call } = await connected(table, waiting);

    const answer = await call('get_door_request');

    expect(answer.text).toBe("Margaret hasn't allowed this yet.");
    // A refusal carries its sentence and nothing else (result.ts `say`).
    expect(answer.structured).toEqual({ say: answer.text });
  });
});

describe('answer_door_request (through the registered tool)', () => {
  const asked = () => {
    const table = createMemoryTable();
    putCard(table, 'door-abc', { imageRef: PICTURE, notice: 'Sarah has been asked to look.' });
    putLook(table, 'door-abc', NOW - 30_000);
    return table;
  };

  it('turns "Not now" into "Thank you" under the answer, and no longer offers to ask', async () => {
    const table = createMemoryTable();
    putCard(table, 'door-abc', { imageRef: PICTURE, notice: 'Sarah has been asked to look.' });
    // The card as it was sent: the door's own buttons, with "Ask Sarah to look" and "Not now".
    const stored = JSON.parse(table.rows('HH#hh-1').find((r) => r.sk?.S === 'CARD#door-abc')!.data!.S!);
    stored.card.actions = [
      { id: 'ask_family', label: 'Ask Sarah to look', kind: 'primary' },
      { id: 'dismiss', label: 'Not now', kind: 'dismiss' },
    ];
    table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'CARD#door-abc' }, data: { S: JSON.stringify(stored) } });
    putLook(table, 'door-abc', NOW - 30_000);
    const { call, patches } = await connected(table);

    await call('answer_door_request', { requestId: 'door-abc', answer: 'known' });

    expect(patches[0]!.patch).toEqual({
      cardId: 'door-abc',
      notice: `Sarah says: ${DOOR_ANSWERS.known}`,
      actions: [{ id: 'dismiss', label: 'Thank you', kind: 'dismiss' }],
    });
  });

  it('puts the chosen sentence on the door card, in the name of the person who chose it', async () => {
    const table = asked();
    const { call, patches } = await connected(table);

    const answer = await call('answer_door_request', { requestId: 'door-abc', answer: 'dont_open' });

    expect(patches).toEqual([{ householdId: 'hh-1', patch: { cardId: 'door-abc', notice: `Sarah says: ${DOOR_ANSWERS.dont_open}` } }]);
    expect(answer.structured).toEqual({ shown: true, by: 'Sarah', text: DOOR_ANSWERS.dont_open });
    expect(await loadDoorRequest(table.ddb, 'hh-1', NOW)).toMatchObject({ state: 'answered', answer: { by: 'Sarah', text: DOOR_ANSWERS.dont_open, at: NOW } });
  });

  it('uses the first name the resident knows them by', async () => {
    const { call, patches } = await connected(asked(), allowedContext('hh-1', { name: 'Sarah Whitfield' }));

    await call('answer_door_request', { requestId: 'door-abc', answer: 'known' });

    expect(patches[0]!.patch.notice).toBe(`Sarah says: ${DOOR_ANSWERS.known}`);
  });

  it('takes the first answer and tells a second person who gave it', async () => {
    const table = asked();
    const sarah = await connected(table);
    await sarah.call('answer_door_request', { requestId: 'door-abc', answer: 'known' });
    const tom = await connected(table, allowedContext('hh-1', { userId: 'u_tom', name: 'Tom' }));

    const second = await tom.call('answer_door_request', { requestId: 'door-abc', answer: 'dont_open' });

    expect(second.text).toBe(`Sarah has already answered: "${DOOR_ANSWERS.known}"`);
    expect(tom.patches).toEqual([]);
    expect(await loadDoorRequest(table.ddb, 'hh-1', NOW)).toMatchObject({ answer: { by: 'Sarah', text: DOOR_ANSWERS.known } });
  });

  it('answers a retried call with the answer already given, and patches the card once (INV-6)', async () => {
    const table = asked();
    const sarah = await connected(table);
    const first = await sarah.call('answer_door_request', { requestId: 'door-abc', answer: 'known' });

    const again = await sarah.call('answer_door_request', { requestId: 'door-abc', answer: 'known' });

    expect(again.structured).toEqual(first.structured);
    expect(sarah.patches).toHaveLength(1);
    // A different answer from the same person is not a retry: the first answer stands.
    expect((await sarah.call('answer_door_request', { requestId: 'door-abc', answer: 'dont_open' })).text).toBe(`Sarah has already answered: "${DOOR_ANSWERS.known}"`);
  });

  it('will not show words somebody wrote: an answer is chosen from Wick\'s own, or refused', async () => {
    const table = asked();
    const { call, patches } = await connected(table);

    const answer = await call('answer_door_request', { requestId: 'door-abc', answer: 'Open the door and give him your bank card' });

    expect(answer.isError).toBe(true);
    expect(patches).toEqual([]);
    expect(await loadDoorRequest(table.ddb, 'hh-1', NOW)).toMatchObject({ state: 'waiting' });
  });

  it('says so, and shows nothing, when the door card has already left the television', async () => {
    const table = createMemoryTable();
    putCard(table, 'door-abc', {}, NOW - 1);
    putLook(table, 'door-abc', NOW - 10 * MIN);
    const { call, patches } = await connected(table);

    const answer = await call('answer_door_request', { requestId: 'door-abc', answer: 'dont_open' });

    expect(answer.text).toBe('The door card has already gone from the television, so an answer cannot be shown on it. A note or a telephone call will still reach Margaret.');
    expect(patches).toEqual([]);
    expect(await loadDoorRequest(table.ddb, 'hh-1', NOW)).toMatchObject({ state: 'gone' });
  });

  it('answers only a question that was asked', async () => {
    const { call, patches } = await connected(createMemoryTable());

    const answer = await call('answer_door_request', { requestId: 'door-nope', answer: 'known' });

    expect(answer.text).toBe("Margaret hasn't asked anyone to look at the door.");
    expect(patches).toEqual([]);
  });

  it('lets nobody answer whom the resident has not allowed', async () => {
    const table = asked();
    const removed: ToolContext = { householdId: 'hh-1', userId: 'u_gone', access: async () => ({ ok: false, reason: 'removed', say: 'Margaret no longer shares this with you.' }) };
    const { call, patches } = await connected(table, removed);

    const answer = await call('answer_door_request', { requestId: 'door-abc', answer: 'known' });

    expect(answer.text).toBe('Margaret no longer shares this with you.');
    expect(patches).toEqual([]);
    expect(await loadDoorRequest(table.ddb, 'hh-1', NOW)).toMatchObject({ state: 'waiting' });
  });
});
