import { describe, expect, it, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMessageCard, registerSendNoteToTv } from '../send_note_to_tv.js';
import { allowedContext } from './toolContext.js';

// INV-2: services/agent/src/egress.ts is the only module allowed to touch a
// transport client; send_note_to_tv.ts calls sendToDevice() from @wick/agent
// rather than importing DynamoDB/transport clients itself. Mocked at that
// import boundary — vitest.config.ts already aliases '@wick/agent' to
// services/agent/src/index.ts, so vi.mock('@wick/agent', ...) intercepts the
// same specifier send_note_to_tv.ts imports.
const sendToDevice = vi.fn();
vi.mock('@wick/agent', () => ({ sendToDevice: (...args: unknown[]) => sendToDevice(...args) }));

describe('buildMessageCard', () => {
  it('builds a MESSAGE card with three static suggested replies', () => {
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
    expect(card.card.type === 'MESSAGE' && card.card.suggestedReplies).toHaveLength(3);
    expect(card.urgency).toBe('DEFERRED');
    expect(card.shownCount).toBe(0);
  });
});

describe('registerSendNoteToTv (registered tool handler, end to end)', () => {
  beforeEach(() => {
    sendToDevice.mockReset();
  });

  it('sends the note in the signed-in member’s own name, to the household their token is for', async () => {
    sendToDevice.mockResolvedValue(undefined);

    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerSendNoteToTv(mcpServer, allowedContext('hh-9', { name: 'Tom' }));

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
    registerSendNoteToTv(mcpServer, allowedContext('hh-9', { name: 'Tom' }));

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
    });

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
    registerSendNoteToTv(mcpServer, allowedContext('hh-9'));

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
