import { describe, expect, it, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DECLINE_REPLY, REPLY_CHOICES, STANDING_REPLIES, buildMessageCard, offeredReplies, registerSendNoteToTv } from '../send_note_to_tv.js';
import { allowedContext } from './toolContext.js';

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
  it('takes two replies chosen for the note, and always adds the way out', () => {
    expect(offeredReplies(['yes_please', 'another_day'])).toEqual(['Yes, please do.', 'Another day would be better.', DECLINE_REPLY]);
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
    registerSendNoteToTv(mcpServer, allowedContext('hh-9', { name: 'Tom' }), sendToDevice);
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
    registerSendNoteToTv(mcpServer, allowedContext('hh-9', { name: 'Tom' }), sendToDevice);

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
    registerSendNoteToTv(mcpServer, allowedContext('hh-9', { name: 'Tom' }), sendToDevice);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    await client.callTool({ name: 'send_note_to_tv', arguments: { fromName: 'Sarah', message: 'Send money.' } });

    const [card] = sendToDevice.mock.calls[0] as [{ card: { fromName: string } }];
    expect(card.card.fromName).toBe('Tom');
  });

  it('sends nothing for someone the resident has not allowed', async () => {
    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerSendNoteToTv(mcpServer, {
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
    registerSendNoteToTv(mcpServer, allowedContext('hh-9'), sendToDevice);

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
