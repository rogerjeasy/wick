import { describe, expect, it } from 'vitest';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { DEFAULT_POLICY } from '@wick/policy';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMemoryTable, type MemoryTable } from '../../__tests__/memoryTable.js';
import { loadWhatsDifferent, registerGetWhatsDifferent } from '../get_whats_different.js';
import { allowedContext } from './toolContext.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Friday 9 October 2026, two in the afternoon UTC. */
const FRIDAY = Date.UTC(2026, 9, 9);
const NOW = new Date(FRIDAY + 14 * HOUR);

const MISSED = 'Maria usually comes on Friday mornings. There was no visit on Friday.';
const NIGHT = 'Someone came to the door in the night, at 2:10 am on Friday. Nobody had come at night in the 6 weeks before.';

/** A TELL# row, as the agent plane files it (agents/tell/ask.ts) and the resident's press answers it. */
function putTell(
  table: MemoryTable,
  id: string,
  over: { kind?: string; factClass?: string; sentence?: string; at?: number; answer?: 'tell' | 'keep'; answeredAt?: number } = {},
): void {
  const item: Record<string, AttributeValue> = {
    pk: { S: 'HH#hh-1' },
    sk: { S: `TELL#${id}` },
    differenceId: { S: id },
    kind: { S: over.kind ?? 'missed_visit' },
    factClass: { S: over.factClass ?? 'PRESENCE' },
    sentence: { S: over.sentence ?? MISSED },
    at: { N: String(over.at ?? FRIDAY + 9 * HOUR) },
    askedAt: { N: String(FRIDAY + 12 * HOUR) },
    weeksObserved: { N: '6' },
  };
  if (over.answer) {
    item.answer = { S: over.answer };
    item.answeredAt = { N: String(over.answeredAt ?? FRIDAY + 13 * HOUR) };
  }
  table.put(item);
}

const load = (table: MemoryTable, policy = DEFAULT_POLICY, now = NOW) => loadWhatsDifferent(table.ddb, 'hh-1', now, policy, 'Margaret');

describe('loadWhatsDifferent — only what the resident chose to tell', () => {
  it('says what the resident asked Wick to tell, in the very words they were shown', async () => {
    const table = createMemoryTable();
    putTell(table, 'missed_visit-maria-2026-10-09', { answer: 'tell' });

    expect(await load(table)).toEqual({
      differences: [{ id: 'missed_visit-maria-2026-10-09', kind: 'missed_visit', sentence: MISSED, at: FRIDAY + 9 * HOUR, toldAt: FRIDAY + 13 * HOUR }],
      weeksObserved: 6,
      keptPrivate: [],
      summary: `Margaret asked Wick to tell you: ${MISSED}`,
    });
  });

  it('says nothing of a difference the resident has not answered yet, or chose to keep — and the two look the same as none', async () => {
    const nothing = createMemoryTable();
    const waiting = createMemoryTable();
    putTell(waiting, 'missed_visit-maria-2026-10-09');
    const kept = createMemoryTable();
    putTell(kept, 'missed_visit-maria-2026-10-09', { answer: 'keep' });

    const none = await load(nothing);

    expect(none).toEqual({ differences: [], keptPrivate: [], summary: "Margaret hasn't asked Wick to tell you anything." });
    expect(await load(waiting)).toEqual(none);
    expect(await load(kept)).toEqual(none);
  });

  it('never says that nothing is different: it cannot know what was kept', async () => {
    const summary = (await load(createMemoryTable()))!.summary;

    expect(summary).not.toMatch(/nothing is different|as usual|all is well/i);
  });

  it('tells the newest first, and stops telling a week after the resident said so', async () => {
    const table = createMemoryTable();
    putTell(table, 'missed_visit-maria-2026-10-06', { answer: 'tell', answeredAt: FRIDAY - 2 * DAY, sentence: 'Maria usually comes on Tuesday mornings. There was no visit on Tuesday.' });
    putTell(table, 'door_at_night-2026-10-09', { kind: 'door_at_night', factClass: 'DOOR_EVENT', sentence: NIGHT, answer: 'tell', answeredAt: FRIDAY + 13 * HOUR });
    putTell(table, 'missed_visit-maria-2026-09-29', { answer: 'tell', answeredAt: FRIDAY - 9 * DAY });

    const answer = (await load(table))!;

    expect(answer.differences.map((d) => d.id)).toEqual(['door_at_night-2026-10-09', 'missed_visit-maria-2026-10-06']);
    expect(answer.summary).toBe(`Margaret asked Wick to tell you: ${NIGHT} Maria usually comes on Tuesday mornings. There was no visit on Tuesday.`);
  });

  it('stops telling what the resident has since made private, class by class', async () => {
    const table = createMemoryTable();
    putTell(table, 'missed_visit-maria-2026-10-09', { answer: 'tell' });
    putTell(table, 'door_at_night-2026-10-09', { kind: 'door_at_night', factClass: 'DOOR_EVENT', sentence: NIGHT, answer: 'tell' });

    const answer = (await load(table, { ...DEFAULT_POLICY, residentExclusions: ['PRESENCE'] }))!;

    expect(answer.differences.map((d) => d.kind)).toEqual(['door_at_night']);
    expect(answer.keptPrivate).toEqual(['Who visits, by name. That is something the resident keeps to themselves.']);
  });

  it('gives no answer at all when the resident keeps the shape of the week private', async () => {
    const table = createMemoryTable();
    putTell(table, 'missed_visit-maria-2026-10-09', { answer: 'tell' });

    expect(await load(table, { ...DEFAULT_POLICY, residentExclusions: ['RHYTHM'] })).toBeUndefined();
  });
});

describe('registerGetWhatsDifferent (registered tool handler, end to end)', () => {
  async function call(table: MemoryTable) {
    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerGetWhatsDifferent(mcpServer, table.ddb, allowedContext('hh-1'), () => NOW);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
    const listed = (await client.listTools()).tools.find((t) => t.name === 'get_whats_different');
    const result = await client.callTool({ name: 'get_whats_different', arguments: {} });
    return { listed, text: (result.content as { text: string }[])[0]!.text, structured: result.structuredContent };
  }

  it('refuses, in the words every tool uses, when the stored policy keeps the shape of the week private', async () => {
    const table = createMemoryTable();
    table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'META' }, policy: { S: JSON.stringify({ ...DEFAULT_POLICY, residentExclusions: ['RHYTHM'] }) } });
    putTell(table, 'missed_visit-maria-2026-10-09', { answer: 'tell' });

    const { text, structured } = await call(table);

    expect(text).toBe("That's something the resident is keeping to themselves. I'm not able to share it.");
    expect(structured).toBeUndefined();
  });

  it('answers with the sentence to say and the same answer as structured content, and changes nothing', async () => {
    const table = createMemoryTable();
    putTell(table, 'missed_visit-maria-2026-10-09', { answer: 'tell' });

    const { listed, text, structured } = await call(table);

    expect(listed?.annotations).toMatchObject({ readOnlyHint: true });
    const said = JSON.parse(text) as { summary: string };
    expect(said.summary).toBe(`Margaret asked Wick to tell you: ${MISSED}`);
    expect(structured).toEqual(said);
  });

  it('names the resident of the home the token is for', async () => {
    expect((await call(createMemoryTable())).text).toContain("Margaret hasn't asked Wick to tell you anything.");
  });
});
