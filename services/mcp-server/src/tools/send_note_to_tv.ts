/**
 * MCP tool: send_note_to_tv — enqueues a MessageCard (M3). See §7.3.
 *
 * INV-2: sendToDevice() (services/agent/src/egress.ts) is the only legal path
 * to the television. This file never touches DynamoDB or a transport client
 * directly — it builds a card and hands it to the sender the server was
 * given (server.ts AppDeps.sendCard), which in a deployment is sendToDevice
 * and nothing else. It is handed in, not imported here, so that a server
 * started for a test or on a laptop sends where it was told to — this file
 * used to call sendToDevice itself, and a local server with AWS
 * credentials in reach wrote its test notes to the real table.
 *
 * suggestedReplies are three static, generic strings — model-drafted replies
 * "in the resident's own register" are M3's full build, sequenced later
 * (§15 Step 8), not part of S4a. Drafting one here would also be a model call
 * inside a tool handler, which §9.3 forbids outright.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_CARD_DETAIL_CHARS, type QueuedCard } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { WRITES, data } from './result.js';

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

export function registerSendNoteToTv(
  mcpServer: McpServer,
  ctx: ToolContext,
  sendCard: (card: QueuedCard) => Promise<void>,
): void {
  mcpServer.registerTool(
    'send_note_to_tv',
    {
      title: 'Send a note to the television',
      description: 'Enqueues a message card on the household television, in the name of the family member who is signed in, with three generic quick replies.',
      inputSchema: {
        message: z.string().min(1).max(MAX_CARD_DETAIL_CHARS).describe(`The note text, at most ${MAX_CARD_DETAIL_CHARS} characters: it is read on a television, in large type, in full.`),
      },
      annotations: WRITES,
    },
    // The sender is never an argument. The resident trusts the name on the
    // card, so it is the name of the person the resident allowed — a note
    // cannot be made to say it came from somebody else.
    withFriendlyErrors(gated(ctx, async (allowed, { message }: { message: string }) => {
      const fromName = allowed.membership.name;
      const card = buildMessageCard({
        householdId: ctx.householdId,
        correlationId: randomUUID(),
        fromName,
        message,
        now: Date.now(),
      });
      await sendCard(card);
      return data({ sent: true, cardId: card.id, fromName, message });
    })),
  );
}
