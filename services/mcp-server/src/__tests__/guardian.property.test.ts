/**
 * INV-4 on the runtime path (docs/WICK-TECHNICAL.md §6.3): no string with a
 * protected phrase in it reaches a family member — through the real MCP
 * server's tools (server.ts createMcpServer), a family member's own
 * television (accounts/familyTelevision.ts), or the family app's assistant
 * (assistant/brain.ts).
 *
 * The phrases are the lexicon's own examples (services/policy lexicon.ts),
 * in any case, with accents added, in full-width letters, inside any
 * string. What is checked is everything the family is handed: every string
 * of the answer, read the way the lexicon reads, must not hold the phrase.
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { currentIsoWeek, type FamilyTvHome, type WeekNarrative } from '@wick/contracts';
import { LEXICON, normalise } from '@wick/policy';
import { createMcpServer } from '../server.js';
import { guardTools } from '../guardian.js';
import { data, say } from '../tools/result.js';
import { allowedContext } from '../tools/__tests__/toolContext.js';
import { nextStep, type ModelReply, type Turn } from '../assistant/brain.js';
import { createMemoryTable } from './memoryTable.js';
import { NOW, bearer, putDoorCard, putLook, world } from '../accounts/__tests__/familyTvWorld.js';

/** Each case connects a client or reads a table: fewer runs than the pure suite's, and still every phrase many times over. */
const RUNS = 400;

const ACUTE = String.fromCharCode(0x301);
const FULL_WIDTH_A = 0xff21;

/** A letter as it might be typed: either case, with an accent, or full-width. */
const disguise = (c: string, how: number): string => {
  if (!/[a-z]/i.test(c)) return c;
  switch (how % 4) {
    case 0: return c.toUpperCase();
    case 1: return c.toLowerCase();
    case 2: return `${c}${ACUTE}`;
    default: return String.fromCharCode(c.toUpperCase().charCodeAt(0) - 0x41 + FULL_WIDTH_A);
  }
};

const arbPhrase = fc.constantFrom(...LEXICON.flatMap((m) => m.examples));

/** A phrase, disguised, and the phrase as the lexicon reads it. */
const arbMarker = fc
  .tuple(arbPhrase, fc.array(fc.nat(3), { minLength: 1, maxLength: 40 }))
  .map(([phrase, hows]) => ({ written: [...phrase].map((c, i) => disguise(c, hows[i % hows.length]!)).join(''), plain: normalise(phrase)! }));

const arbEdge = fc.constantFrom(' ', '. ', ', ', '\n', ' (', ') ', ' “', '” ', ' - ', '? ', '! ');

/** A string with a protected phrase in it, as a word of its own. */
const arbProtected = fc
  .tuple(fc.string({ maxLength: 40 }), arbEdge, arbMarker, arbEdge, fc.string({ maxLength: 40 }))
  .map(([before, l, marker, r, after]) => ({ text: `${before}${l}${marker.written}${r}${after}`, plain: marker.plain }));

/** Every string in what the family was handed. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

/**
 * Whether the phrase reached the family: some string they were handed holds
 * it, read as the lexicon reads. A string that cannot be read at all counts
 * as reaching them — nothing unreadable may be handed over either.
 */
function reached(answer: unknown, plain: string): boolean {
  return strings(answer).some((s) => {
    const read = normalise(s);
    return read === undefined || read.includes(plain);
  });
}

async function connect(server: McpServer): Promise<Client> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.1.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const nowhere = async (): Promise<void> => {};

// The gate notes each thing it holds back; thousands of lines say nothing here.
beforeAll(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterAll(() => void vi.restoreAllMocks());

describe('INV-4, through every way the family is answered', () => {
  it('any tool, whatever helper builds its answer, hands the family no protected phrase', async () => {
    let next: unknown;
    const server = guardTools(new McpServer({ name: 'test', version: '0.1.0' }));
    server.registerTool('anything', { description: 'Answers with whatever it is given.', inputSchema: {} }, async () => next as ReturnType<typeof say>);
    const client = await connect(server);

    const shapes = (text: string): unknown[] => [
      say(text),
      data({ summary: text }),
      data({ visitors: [{ personId: 'x', name: text }], nested: { deeper: [[text]] } }),
      { content: [{ type: 'text', text: 'A plain sentence first.' }, { type: 'text', text }] },
    ];

    await fc.assert(
      fc.asyncProperty(arbProtected, fc.nat(3), async ({ text, plain }, shape) => {
        next = shapes(text)[shape];
        const result = await client.callTool({ name: 'anything', arguments: {} });
        expect(reached(result.content, plain) || reached(result.structuredContent, plain)).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('get_door_request never hands on the door’s sentence with a protected phrase — and the question still arrives', async () => {
    const table = createMemoryTable();
    const client = await connect(createMcpServer(table.ddb, allowedContext('hh-1'), nowhere, nowhere, nowhere));
    putLook(table, 'door-abc', Date.now() - 30_000);

    await fc.assert(
      fc.asyncProperty(arbProtected, async ({ text, plain }) => {
        putDoorCard(table, 'door-abc', { description: text }, Date.now() + 240_000);
        const result = await client.callTool({ name: 'get_door_request', arguments: {} });
        expect(reached(result.content, plain) || reached(result.structuredContent, plain)).toBe(false);
        expect(result.structuredContent).toMatchObject({ state: 'waiting', requestId: 'door-abc' });
      }),
      { numRuns: RUNS },
    );
  });

  it('a family member’s own television is never shown the door’s sentence with a protected phrase', async () => {
    const w = await world();
    putLook(w.table, 'door-abc', NOW - 30_000);

    await fc.assert(
      fc.asyncProperty(arbProtected, async ({ text, plain }) => {
        putDoorCard(w.table, 'door-abc', { description: text });
        const reply = await w.tv.home(bearer());
        expect(reply.status).toBe(200);
        expect(reached(reply.body, plain)).toBe(false);
        expect((reply.body as FamilyTvHome).cards[0]).toMatchObject({ kind: 'door_look' });
        const waiting = await w.tv.waiting(bearer());
        expect(reached(waiting.body, plain)).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('get_week_narrative never hands on a paragraph or a visitor’s name with a protected phrase — and the week is still told', async () => {
    const table = createMemoryTable();
    const client = await connect(createMcpServer(table.ddb, allowedContext('hh-1'), nowhere, nowhere, nowhere));

    await fc.assert(
      fc.asyncProperty(arbProtected, arbProtected, async (paragraph, name) => {
        const at = Date.now();
        const isoWeek = currentIsoWeek(new Date(at));
        const narrative: WeekNarrative = {
          householdId: 'hh-1', isoWeek, text: paragraph.text, textSource: 'model',
          deltas: [{ metric: 'visit:x', label: name.text, thisWeek: 0, baseline: 2, zScore: -2, baselineWeeks: 4, verdict: 'fewer' }],
          timeline: [{ at, kind: 'visit', summary: `${name.text} visited.`, personId: 'x' }, { at, kind: 'door', summary: 'Someone was at the front door.' }],
          generatedAt: at, residentSeenAt: at,
        };
        table.put({ pk: { S: 'HH#hh-1' }, sk: { S: `NARR#${isoWeek}` }, data: { S: JSON.stringify(narrative) } });
        const result = await client.callTool({ name: 'get_week_narrative', arguments: {} });
        for (const plain of [paragraph.plain, name.plain]) {
          expect(reached(result.content, plain) || reached(result.structuredContent, plain)).toBe(false);
        }
        expect(result.structuredContent).toMatchObject({ isoWeek });
      }),
      { numRuns: RUNS },
    );
  });

  it('get_replies never hands one member’s protected note to another', async () => {
    const table = createMemoryTable();
    const client = await connect(createMcpServer(table.ddb, allowedContext('hh-1', { userId: 'u_sarah' }), nowhere, nowhere, nowhere));

    await fc.assert(
      fc.asyncProperty(arbProtected, async ({ text, plain }) => {
        table.put({
          pk: { S: 'HH#hh-1' },
          sk: { S: 'CARD#note-1' },
          sentBy: { S: 'u_tom' },
          replyText: { S: "I'm fine, thank you." },
          repliedAt: { N: String(Date.now()) },
          data: { S: JSON.stringify({ id: 'note-1', queuedAt: Date.now() - 60_000, card: { type: 'MESSAGE', fromName: 'Tom', transcript: text, suggestedReplies: [] } }) },
        });
        const result = await client.callTool({ name: 'get_replies', arguments: {} });
        expect(reached(result.content, plain) || reached(result.structuredContent, plain)).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('the family app’s assistant never says a protected phrase, whatever its model replies', async () => {
    const turns: Turn[] = [{ role: 'user', text: 'How is she?' }];
    await fc.assert(
      fc.asyncProperty(arbProtected, async ({ text, plain }) => {
        const converse = async (): Promise<ModelReply> => ({ text, calls: [] });
        const step = await nextStep({
          converse,
          tools: [],
          who: { memberName: 'Sarah', residentName: 'Margaret', householdName: 'Mum’s house', simulated: false },
          now: new Date(NOW),
          timeZone: 'Europe/London',
        }, turns);
        expect(reached(step, plain)).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });
});
