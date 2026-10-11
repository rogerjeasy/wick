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
 * of them can now be fitted to the note: "Shall I come on Saturday?" is
 * better answered "Yes, please do." than "Thanks for letting me know!".
 *
 * They are chosen, never written, by whoever calls the tool. The caller —
 * the assistant, which already has the note in front of it — passes the
 * keys of two replies from REPLY_CHOICES, a short list of sentences Wick
 * itself wrote. No model is called here (§9.3 forbids one inside a tool
 * handler), and no text a caller supplies is ever shown as something the
 * resident can say: what the resident presses is recorded as their answer
 * and read to the family (edge-device note-reply.mjs, get_replies), so
 * words a caller wrote would be words put in the resident's mouth.
 *
 *   - Two keys from the list, or the standing three are used instead.
 *   - The third is always "Not right now.": whatever the other two say,
 *     the resident can decline.
 *   - Exactly one set is ever stored and shown, so what was pressed is
 *     what the family is told.
 *
 * The family app shows the replies with the note before it is sent.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_CARD_DETAIL_CHARS, type QueuedCard } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { WRITES, data } from './result.js';

/** The way out that is always offered. */
export const DECLINE_REPLY = 'Not right now.';
/** What a note is answered with when nothing fitter was chosen. */
export const STANDING_REPLIES = ['Thanks for letting me know!', "I'll call you soon.", DECLINE_REPLY] as const;

/**
 * Every reply a note can be sent with, besides the standing three. Wick's
 * own sentences: short enough for a button in large type, and none that
 * agrees to anything but a visit, a call or a kindness.
 */
export const REPLY_CHOICES = {
  yes_please: 'Yes, please do.',
  yes_fine: "Yes, that's fine.",
  love_to: "I'd love that.",
  another_day: 'Another day would be better.',
  a_bit_later: 'A bit later would be better.',
  no_thank_you: 'No, thank you.',
  thank_you: 'Thank you!',
  call_soon: "I'll call you soon.",
  please_call: 'Please call me.',
  im_fine: "I'm fine, thank you.",
  you_too: 'Thinking of you too.',
  lovely: "That's lovely to hear.",
} as const;
export type ReplyChoice = keyof typeof REPLY_CHOICES;

const isChoice = (key: unknown): key is ReplyChoice => typeof key === 'string' && Object.hasOwn(REPLY_CHOICES, key);

/**
 * The three replies a note is sent with: the two chosen for it and the way
 * out, or the standing three. Anything that is not a key from the list —
 * a sentence somebody wrote, most of all — is not a choice, and never half
 * a set: one usable key is not enough.
 */
export function offeredReplies(chosen: readonly unknown[] | undefined): readonly string[] {
  if (!Array.isArray(chosen)) return [...STANDING_REPLIES];
  const keys = [...new Set(chosen.filter(isChoice))].slice(0, 2);
  return keys.length === 2 ? [REPLY_CHOICES[keys[0]!], REPLY_CHOICES[keys[1]!], DECLINE_REPLY] : [...STANDING_REPLIES];
}

export interface BuildMessageCardInput {
  readonly householdId: string;
  readonly correlationId: string;
  readonly fromName: string;
  readonly message: string;
  /** Keys of the two replies chosen for this note from REPLY_CHOICES. Checked by offeredReplies. */
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
        'Pass `replies`: the keys of the two replies from this list that best answer this particular note — ' +
        `${Object.entries(REPLY_CHOICES).map(([key, text]) => `${key} ("${text}")`).join(', ')}. ` +
        `A third, "${DECLINE_REPLY}", is always added. Without two keys from the list the standing three are used. Replies cannot be written, only chosen. ` +
        'The answer says which replies were offered (`replies`).',
      inputSchema: {
        message: z.string().min(1).max(MAX_CARD_DETAIL_CHARS).describe(`The note text, at most ${MAX_CARD_DETAIL_CHARS} characters: it is read on a television, in large type, in full.`),
        replies: z.array(z.string()).max(3).optional().describe('The keys of two replies from the list in this tool’s description, e.g. ["yes_please", "another_day"].'),
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
