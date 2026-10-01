/**
 * MCP tool: send_note_to_tv — enqueues a MessageCard (M3). See §7.3.
 *
 * INV-2: sendToDevice() (services/agent/src/egress.ts) is the only legal path
 * to the television. This file never touches DynamoDB or a transport client
 * directly — it builds a card and hands it to sendToDevice().
 *
 * suggestedReplies are three static, generic strings — model-drafted replies
 * "in the resident's own register" are M3's full build, sequenced later
 * (§15 Step 8), not part of S4a. Drafting one here would also be a model call
 * inside a tool handler, which §9.3 forbids outright.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_CARD_DETAIL_CHARS, type QueuedCard } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { sendToDevice } from '@wick/agent';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HOUSEHOLD_ID } from '../auth.js';
import { withFriendlyErrors } from './errors.js';

const STATIC_SUGGESTED_REPLIES = ['Thanks for letting me know!', "I'll call you soon.", 'Not right now.'] as const;

export interface BuildMessageCardInput {
  readonly householdId: string;
  readonly correlationId: string;
  readonly fromName: string;
  readonly message: string;
  readonly now: number;
}

export function buildMessageCard(input: BuildMessageCardInput): QueuedCard {
  const cardId = `note-${randomUUID()}`;
  return {
    id: cardId,
    urgency: 'DEFERRED',
    card: {
      type: 'MESSAGE',
      id: cardId,
      householdId: input.householdId,
      correlationId: input.correlationId,
      createdAt: input.now,
      actions: [],
      fromName: input.fromName,
      transcript: input.message,
      suggestedReplies: [...STATIC_SUGGESTED_REPLIES],
    },
    queuedAt: input.now,
    shownCount: 0,
  };
}

export function registerSendNoteToTv(mcpServer: McpServer): void {
  mcpServer.registerTool(
    'send_note_to_tv',
    {
      title: 'Send a note to the television',
      description: 'Enqueues a message card on the household television, from a named family member, with three generic quick replies.',
      inputSchema: {
        fromName: z.string().min(1).describe('The sender\'s name, as it should appear on the card.'),
        message: z.string().min(1).max(MAX_CARD_DETAIL_CHARS).describe(`The note text, at most ${MAX_CARD_DETAIL_CHARS} characters: it is read on a television, in large type, in full.`),
      },
    },
    withFriendlyErrors(async ({ fromName, message }: { fromName: string; message: string }) => {
      const card = buildMessageCard({
        householdId: HOUSEHOLD_ID,
        correlationId: randomUUID(),
        fromName,
        message,
        now: Date.now(),
      });
      await sendToDevice(card, DEFAULT_POLICY);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ sent: true, cardId: card.id }) }] };
    }),
  );
}
