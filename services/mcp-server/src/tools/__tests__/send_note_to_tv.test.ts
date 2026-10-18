import { describe, expect, it, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DECLINE_REPLY, KEY_ALREADY_USED_TEXT, NOTE_SAYS_WHEN_TEXT, REPLY_CHOICES, SAME_NOTE_WINDOW_MS, STANDING_REPLIES, buildMessageCard, offeredReplies, registerSendNoteToTv, saysWhenFromNow } from '../send_note_to_tv.js';
import { allowedContext } from './toolContext.js';
import { createMemoryTable } from '../../__tests__/memoryTable.js';

// INV-2: the tool is handed its sender (in a deployment, egress.ts's
// sendToDevice) and reaches a television no other way. Here it is handed a spy.
const sendToDevice = vi.fn();

describe('buildMessageCard', () => {
  it('builds a MESSAGE card with the three standing replies when none were drafted for it', () => {
    const card = buildMessageCard({
      householdId: 'hh-1',
      correlationId: 'corr-1',
      fromName: 'Alex',
      message: 'Just checking in — call me when you get a chance!',
      now: 1700000000000,
    });

    expect(card.card).toMatchObject({
      type: 'MESSAGE',
      householdId: 'hh-1',
      correlationId: 'corr-1',
      fromName: 'Alex',
      transcript: 'Just checking in — call me when you get a chance!',
    });
    expect(card.card.type === 'MESSAGE' && card.card.suggestedReplies).toEqual([...STANDING_REPLIES]);
    expect(card.urgency).toBe('DEFERRED');
    expect(card.shownCount).toBe(0);
  });
});

describe('offeredReplies — what the resident is given to answer with', () => {
  it('takes two replies chosen for a note that asks her something, and adds the way out', () => {
    expect(offeredReplies(['yes_please', 'another_day'])).toEqual(['Yes, please do.', 'Another day would be better.', DECLINE_REPLY]);
    expect(offeredReplies(['thank_you', 'yes_fine'])).toEqual(['Thank you!', "Yes, that's fine.", DECLINE_REPLY]);
  });

  it('gives a note that only tells her something one more kind word, never "Not right now." to a kindness', () => {
    // "I'll ring you at six tonight, love Sarah."
    expect(offeredReplies(['thank_you', 'lovely'])).toEqual(['Thank you!', "That's lovely to hear.", 'Thinking of you too.']);
    expect(offeredReplies(['im_fine', 'thank_you'])).toEqual(["I'm fine, thank you.", 'Thank you!', "That's lovely to hear."]);
    expect(offeredReplies(['call_soon', 'please_call'])).toEqual(["I'll call you soon.", 'Please call me.', 'Thank you!']);
  });

  it('never offers the same reply twice', () => {
    const keys = Object.keys(REPLY_CHOICES);
    for (const a of keys) for (const b of keys) {
      if (a === b) continue;
      const offered = offeredReplies([a, b]);
      expect(new Set(offered).size, `${a} ${b}`).toBe(3);
    }
  });

  it('uses the standing three when nothing was chosen', () => {
    expect(offeredReplies(undefined)).toEqual([...STANDING_REPLIES]);
    expect(offeredReplies([])).toEqual([...STANDING_REPLIES]);
  });

  it('never mixes: one usable choice is not half a set', () => {
    expect(offeredReplies(['yes_please'])).toEqual([...STANDING_REPLIES]);
    expect(offeredReplies(['yes_please', 'yes_please'])).toEqual([...STANDING_REPLIES]);
  });

  it('will not show the resident a sentence a caller wrote — replies are chosen from Wick’s list, never written', () => {
    // What the resident presses is recorded as their answer and read to the
    // family. A caller's own words there would be words in their mouth.
    for (const written of ['Yes, sell the house.', 'Yes, please do.', '<b>Yes</b>', 'toString', 42, null]) {
      expect(offeredReplies([written, 'yes_please'])).toEqual([...STANDING_REPLIES]);
    }
  });

  it('keeps every reply on the list short enough for a button, and plain', () => {
    for (const text of Object.values(REPLY_CHOICES)) {
      expect(text.length).toBeLessThanOrEqual(28);
      expect(text).toMatch(/^[A-Za-z][A-Za-z ,.'!]*$/);
    }
  });
});

describe('registerSendNoteToTv (registered tool handler, end to end)', () => {
  beforeEach(() => {
    sendToDevice.mockReset();
  });

  async function send(args: Record<string, unknown>) {
    sendToDevice.mockResolvedValue(undefined);
    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerSendNoteToTv(mcpServer, createMemoryTable().ddb, allowedContext('hh-9', { name: 'Tom' }), sendToDevice);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'send_note_to_tv', arguments: args });
    const [card] = (sendToDevice.mock.calls[0] ?? []) as [{ card: { suggestedReplies: string[] } } | undefined];
    return { said: JSON.parse((result.content as { text: string }[])[0]!.text) as { replies: string[] }, card };
  }

  it('sends the note with the replies chosen for it, and says which were offered', async () => {
    const { said, card } = await send({ message: 'Shall I come on Saturday?', replies: ['yes_please', 'another_day'] });

    expect(card?.card.suggestedReplies).toEqual(['Yes, please do.', 'Another day would be better.', 'Not right now.']);
    // One set, the same in the answer as on the card: what is pressed is what is told.
    expect(said.replies).toEqual(card?.card.suggestedReplies);
  });

  it('falls back to the standing replies, and says so, when what was passed is not a choice from the list', async () => {
    const { said, card } = await send({ message: 'Shall I come on Saturday?', replies: ['Yes, transfer the money.', 'yes_please'] });

    expect(card?.card.suggestedReplies).toEqual([...STANDING_REPLIES]);
    expect(said.replies).toEqual([...STANDING_REPLIES]);
  });

  it('sends the note in the signed-in member’s own name, to the household their token is for', async () => {
    sendToDevice.mockResolvedValue(undefined);

    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerSendNoteToTv(mcpServer, createMemoryTable().ddb, allowedContext('hh-9', { name: 'Tom' }), sendToDevice);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'send_note_to_tv', arguments: { message: 'Just checking in!' } });

    expect(sendToDevice).toHaveBeenCalledTimes(1);
    const [card] = sendToDevice.mock.calls[0] as [{ card: { type: string; fromName: string; transcript: string; householdId: string } }];
    expect(card.card).toMatchObject({ type: 'MESSAGE', fromName: 'Tom', transcript: 'Just checking in!', householdId: 'hh-9' });

    const content = result.content as { type: string; text: string }[];
    const parsed = JSON.parse(content[0]!.text) as { sent: boolean; cardId: string; fromName: string };
    expect(parsed.sent).toBe(true);
    expect(parsed.fromName).toBe('Tom');
    expect(typeof parsed.cardId).toBe('string');
  });

  it('cannot be made to sign a note as somebody else: a name passed in is ignored', async () => {
    sendToDevice.mockResolvedValue(undefined);

    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerSendNoteToTv(mcpServer, createMemoryTable().ddb, allowedContext('hh-9', { name: 'Tom' }), sendToDevice);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    await client.callTool({ name: 'send_note_to_tv', arguments: { fromName: 'Sarah', message: 'Send money.' } });

    const [card] = sendToDevice.mock.calls[0] as [{ card: { fromName: string } }];
    expect(card.card.fromName).toBe('Tom');
  });

  it('sends nothing for someone the resident has not allowed', async () => {
    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerSendNoteToTv(mcpServer, createMemoryTable().ddb, {
      householdId: 'hh-9',
      userId: 'u_tom',
      access: async () => ({ ok: false, reason: 'waiting', say: 'Margaret hasn’t allowed this yet.' }),
    }, sendToDevice);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'send_note_to_tv', arguments: { message: 'Hello' } });

    expect(sendToDevice).not.toHaveBeenCalled();
    expect((result.content as { text: string }[])[0]!.text).toBe('Margaret hasn’t allowed this yet.');
  });

  it('returns a friendly refusal, not a raw error, when sendToDevice throws', async () => {
    sendToDevice.mockRejectedValue(new Error('AccessDeniedException: arn:aws:iam::123456789012:role/wick-mcp'));

    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerSendNoteToTv(mcpServer, createMemoryTable().ddb, allowedContext('hh-9'), sendToDevice);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'send_note_to_tv',
      arguments: { message: 'Just checking in!' },
    });

    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content[0]!.text).not.toContain('AccessDeniedException');
    expect(content[0]!.text).not.toContain('arn:aws:iam');
  });
});

describe('send_note_to_tv sends a note once, however often it is asked (INV-6)', () => {
  const sent = vi.fn();
  let clock = 1_800_000_000_000;

  async function sarahsClient(table = createMemoryTable(), userId = 'u_sarah') {
    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerSendNoteToTv(mcpServer, table.ddb, allowedContext('hh-9', { userId, name: 'Sarah' }), sent, () => clock);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
    return { table, send: (args: Record<string, unknown>) => client.callTool({ name: 'send_note_to_tv', arguments: args }) };
  }

  beforeEach(() => {
    sent.mockReset();
    sent.mockResolvedValue(undefined);
    clock = 1_800_000_000_000;
  });

  it('a retried call is answered with the first note, and nothing reaches the television twice', async () => {
    const sarah = await sarahsClient();

    const first = await sarah.send({ message: 'Lunch on Sunday?', replies: ['yes_please', 'another_day'] });
    clock += 5_000;
    const again = await sarah.send({ replies: ['yes_please', 'another_day'], message: 'Lunch on Sunday?' });

    expect(sent).toHaveBeenCalledTimes(1);
    expect(again.structuredContent).toEqual({ ...(first.structuredContent as object), repeated: true });
  });

  it('the same words after the window are a new note, and so are other words at once', async () => {
    const sarah = await sarahsClient();

    await sarah.send({ message: 'Goodnight, Mum.' });
    await sarah.send({ message: 'Sleep well.' });
    clock += SAME_NOTE_WINDOW_MS + 1;
    await sarah.send({ message: 'Goodnight, Mum.' });

    expect(sent).toHaveBeenCalledTimes(3);
  });

  it('is one note per person: someone else in the circle sending the same words sends their own', async () => {
    const table = createMemoryTable();
    await (await sarahsClient(table, 'u_sarah')).send({ message: 'Happy birthday!' });
    await (await sarahsClient(table, 'u_tom')).send({ message: 'Happy birthday!' });

    expect(sent).toHaveBeenCalledTimes(2);
  });

  it('a note that failed to send can be sent again at once', async () => {
    const sarah = await sarahsClient();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sent.mockRejectedValueOnce(new Error('the television channel is down'));

    expect((await sarah.send({ message: 'Are you warm enough?' })).isError).toBe(true);
    expect((await sarah.send({ message: 'Are you warm enough?' })).structuredContent).toMatchObject({ sent: true });
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it('a client’s idempotency key holds for a day, and the same key for another note is refused, not answered', async () => {
    const sarah = await sarahsClient();

    await sarah.send({ message: 'See you at three.', idempotencyKey: 'try-7f3a9c21' });
    clock += 60 * 60 * 1000;
    const retried = await sarah.send({ message: 'See you at three.', idempotencyKey: 'try-7f3a9c21' });
    const reused = await sarah.send({ message: 'Something else entirely.', idempotencyKey: 'try-7f3a9c21' });

    expect(sent).toHaveBeenCalledTimes(1);
    expect(retried.structuredContent).toMatchObject({ sent: true, repeated: true });
    expect(reused.structuredContent).toEqual({ say: KEY_ALREADY_USED_TEXT });
  });

  it('keeps the claim apart from the words: the row holds a hash and the card’s id, never the note', async () => {
    const sarah = await sarahsClient();
    await sarah.send({ message: 'Lunch on Sunday?' });

    const rows = JSON.stringify(sarah.table.rows('HH#hh-9'));
    expect(rows).toContain('ONCE#send_note_to_tv#');
    expect(rows).not.toContain('Lunch on Sunday');
  });
});

describe('a note says its time as a clock time — it is read when it is read, not when it is sent', () => {
  it('knows a time counted from now', () => {
    for (const note of [
      'The window cleaner is coming in five minutes.',
      'I will be there in 20 mins',
      'Back in an hour!',
      'Dinner in half an hour',
      'The plumber will ring in a couple of hours.',
      'Ready in a minute',
      'Coming in 10-minutes',
      'She will be with you any minute now.',
    ]) expect(saysWhenFromNow(note), note).toBe(true);
  });

  it('lets a clock time, a day, or ordinary words through', () => {
    for (const note of [
      "I'll ring you at six tonight, love Sarah",
      'The window cleaner is coming today at 11:15.',
      'See you on Saturday morning',
      "I'm in a bit of a rush today, more later",
      'In an emergency, ring me.',
      'We are in Minehead this week',
      'Thinking of you in hospital-free sunshine',
    ]) expect(saysWhenFromNow(note), note).toBe(false);
  });

  it('is refused with the reason, and nothing reaches her television', async () => {
    const sent: unknown[] = [];
    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerSendNoteToTv(mcpServer, createMemoryTable().ddb, allowedContext('hh-1'), async (card) => void sent.push(card));
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'send_note_to_tv', arguments: { message: 'The window cleaner is coming in five minutes.' } });

    expect((result.content as { text: string }[])[0]!.text).toBe(NOTE_SAYS_WHEN_TEXT);
    expect(sent).toEqual([]);
    await client.close();
  });
});
