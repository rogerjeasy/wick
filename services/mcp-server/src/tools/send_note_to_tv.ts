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
 * The replies (M3). A note is answered with one of three buttons, and two
 * of them can now be written for the note: "Shall I come on Saturday?" is
 * better answered "Yes, please do." than "Thanks for letting me know!".
 *
 * They are drafted by whoever calls the tool — the assistant that already
 * has the note in front of it — and passed in as `replies`. Not drafted
 * here: a model call inside a tool handler is what §9.3 forbids, and would
 * put seconds into a round trip that has to stay a write or two.
 *
 * What arrives is checked, not trusted (offeredReplies below):
 *
 *   - Two short plain lines, or the standing three are used instead.
 *   - The third is always Wick's own "Not right now." Whatever the other
 *     two say, the resident can decline, in words no caller chose.
 *   - Exactly one set is ever stored and shown. The television sends back
 *     which button was pressed, and the words are read from the stored
 *     card (edge-device note-reply.mjs) — so what the resident pressed is
 *     what the family is told, and nothing else can be.
 *
 * The family app shows the replies with the note before it is sent, so
 * the person sending it sees what the resident will be offered.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_CARD_DETAIL_CHARS, type QueuedCard } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { WRITES, data } from './result.js';

/** The way out that is always offered, in Wick's words. */
export const DECLINE_REPLY = 'Not right now.';
/** What a note is answered with when nothing fitter was offered. */
export const STANDING_REPLIES = ['Thanks for letting me know!', "I'll call you soon.", DECLINE_REPLY] as const;
/** A button on the television, in large type: the longest standing reply is 27. */
export const MAX_REPLY_CHARS = 28;

/** Letters, digits and the punctuation of a spoken sentence. Nothing that is markup, a link or a line break. */
const PLAIN_REPLY = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} ,.'’!?-]*$/u;

/**
 * The three replies a note is sent with: two drafted for it and the standing
 * way out, or the standing three when what was drafted will not do. Never a
 * mixture of a drafted reply and a standing one in the first two places —
 * half a set reads as a mistake.
 */
export function offeredReplies(drafted: readonly unknown[] | undefined): readonly string[] {
  if (!Array.isArray(drafted)) return [...STANDING_REPLIES];
  const usable: string[] = [];
  for (const raw of drafted) {
    // One line, as a button is. A reply that arrives with a line break in it is not tidied into one.
    if (typeof raw !== 'string' || /[\u0000-\u001f\u007f]/.test(raw)) continue;
    const reply = raw.trim().replace(/ +/g, ' ');
    if (reply.length < 2 || reply.length > MAX_REPLY_CHARS || !PLAIN_REPLY.test(reply)) continue;
    const said = reply.toLowerCase();
    if (said === DECLINE_REPLY.toLowerCase() || usable.some((u) => u.toLowerCase() === said)) continue;
    usable.push(reply);
    if (usable.length === 2) break;
  }
  return usable.length === 2 ? [usable[0]!, usable[1]!, DECLINE_REPLY] : [...STANDING_REPLIES];
}

export interface BuildMessageCardInput {
  readonly householdId: string;
  readonly correlationId: string;
  readonly fromName: string;
  readonly message: string;
  /** Replies drafted for this note by the caller. Checked by offeredReplies. */
  readonly replies?: readonly unknown[] | undefined;
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
      suggestedReplies: [...offeredReplies(input.replies)],
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
      description:
        'Puts a note on the household television, in the name of the family member who is signed in. The resident answers with one of three buttons. ' +
        'Pass `replies`: two short answers the resident might give to this particular note, in plain warm words (for "Shall I come on Saturday?": "Yes, please do." and "Another day would be better."). ' +
        `Each at most ${MAX_REPLY_CHARS} characters. Never one that agrees to anything the note did not ask. A third, "${DECLINE_REPLY}", is always added; without two usable replies the standing three are used. ` +
        'The answer says which replies were offered (`replies`).',
      inputSchema: {
        message: z.string().min(1).max(MAX_CARD_DETAIL_CHARS).describe(`The note text, at most ${MAX_CARD_DETAIL_CHARS} characters: it is read on a television, in large type, in full.`),
        replies: z.array(z.string()).max(3).optional().describe(`Two short replies drafted for this note, each at most ${MAX_REPLY_CHARS} characters.`),
      },
      annotations: WRITES,
    },
    // The sender is never an argument. The resident trusts the name on the
    // card, so it is the name of the person the resident allowed — a note
    // cannot be made to say it came from somebody else.
    withFriendlyErrors(gated(ctx, async (allowed, { message, replies }: { message: string; replies?: string[] | undefined }) => {
      const fromName = allowed.membership.name;
      const card = buildMessageCard({
        householdId: ctx.householdId,
        correlationId: randomUUID(),
        fromName,
        message,
        replies,
        now: Date.now(),
      });
      await sendCard(card);
      const offered = card.card.type === 'MESSAGE' ? card.card.suggestedReplies : [];
      return data({ sent: true, cardId: card.id, fromName, message, replies: offered });
    })),
  );
}
