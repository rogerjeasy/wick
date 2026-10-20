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
 *   - The third is the way out when the note asks her something: "Shall I
 *     come on Saturday?" can always be answered "Not right now.". A note
 *     that only tells her something ("I'll ring you at six") asks nothing
 *     to decline, and "Not right now." to it reads as a refusal of a
 *     kindness, so its third is one more kind word (thirdReply). Back on
 *     the television puts any note aside unanswered (contracts card.ts
 *     NOTE_ACTIONS.later).
 *   - Exactly one set is ever stored and shown, so what was pressed is
 *     what the family is told.
 *
 * The family app shows the replies with the note before it is sent.
 *
 * Who wrote the note is kept on its row (`sentBy`), never on the card the
 * television is sent: a note's words are read back to the person who wrote
 * them, and to nobody else in the family (get_replies.ts). The same words
 * are handed back here, to the same person, as theirs (guardian.ts
 * `theirOwnWords`).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_CARD_DETAIL_CHARS, saidOnHerClock, type QueuedCard } from '@wick/contracts';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { answerSchema, WRITES, data, say } from './result.js';
import { callKey, claimOnce } from './once.js';
import { theirOwnWords } from '../guardian.js';

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
  talk_then: 'Talk to you then.',
} as const;
export type ReplyChoice = keyof typeof REPLY_CHOICES;

const isChoice = (key: unknown): key is ReplyChoice => typeof key === 'string' && Object.hasOwn(REPLY_CHOICES, key);

/** Replies that answer a question or a plan — and so need, beside them, a way to say no. */
export const ANSWERING_REPLIES: readonly ReplyChoice[] = ['yes_please', 'yes_fine', 'love_to', 'another_day', 'a_bit_later', 'no_thank_you'];
/** The kind words a note that only tells her something is given as its third, in this order. */
export const KIND_REPLIES: readonly ReplyChoice[] = ['thank_you', 'lovely', 'you_too'];

/**
 * The third reply beside two chosen ones: the way out when either answers
 * a question, otherwise the first kind word not already there. Of three
 * kind words two can be chosen at most, so one is always left.
 */
export function thirdReply(chosen: readonly ReplyChoice[]): string {
  if (chosen.some((key) => ANSWERING_REPLIES.includes(key))) return DECLINE_REPLY;
  const spare = KIND_REPLIES.find((key) => !chosen.includes(key));
  return spare ? REPLY_CHOICES[spare] : DECLINE_REPLY;
}

/**
 * The three replies a note is sent with: the two chosen for it and the way
 * out, or the standing three. Anything that is not a key from the list —
 * a sentence somebody wrote, most of all — is not a choice, and never half
 * a set: one usable key is not enough.
 */
export function offeredReplies(chosen: readonly unknown[] | undefined): readonly string[] {
  if (!Array.isArray(chosen)) return [...STANDING_REPLIES];
  const keys = [...new Set(chosen.filter(isChoice))].slice(0, 2);
  return keys.length === 2 ? [REPLY_CHOICES[keys[0]!], REPLY_CHOICES[keys[1]!], thirdReply(keys)] : [...STANDING_REPLIES];
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

/**
 * How a card reaches the resident's television: egress.ts's sendToDevice,
 * handed in (server.ts AppDeps). `sentBy` is who wrote a note, kept beside
 * the card and never in it.
 */
export type SendCard = (card: QueuedCard, serverOnly?: { readonly sentBy?: string }) => Promise<void>;

/** What this tool's structured content is (result.ts `answerSchema`): built once, for every request. */
const OUTPUT = answerSchema({
  sent: z.literal(true),
  cardId: z.string(),
  fromName: z.string(),
  message: z.string(),
  replies: z.array(z.string()).describe('The buttons the resident is offered, in order.'),
  repeated: z.literal(true).optional().describe('The same note was sent moments ago, and was not sent again: this is that note.'),
});

/**
 * How long the same note from the same person counts as the same call
 * (tools/once.ts): long enough for a client's retry, or a second press of
 * Send, and short enough that saying the same thing again later is a note.
 */
export const SAME_NOTE_WINDOW_MS = 2 * 60 * 1000;
/** How long a client's own idempotency key holds. */
export const IDEMPOTENCY_KEY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const NOTE_ON_ITS_WAY_TEXT = 'That note is already on its way to the television.';
export const NOTE_SAYS_WHEN_TEXT =
  'A note waits for a quiet moment on her television, so it may be read some time after it is sent. Say the time instead, such as "at 11:15 am" or "this afternoon at three", not "in five minutes".';

const COUNT = '(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|forty-five|fifty|sixty|a few|a couple of|several|\\d+)';
/** "in five minutes", "in an hour", "in half an hour", "in a minute": a time counted from when the note was written. */
const FROM_NOW = new RegExp(`\\bin\\s+(?:${COUNT}\\s*(?:-\\s*)?(?:min(?:ute)?s?|hours?|hrs?)|half\\s+an?\\s+hour|an?\\s+(?:minute|moment|sec(?:ond)?))\\b|\\bany\\s+(?:minute|moment)\\s+now\\b`, 'i');

/**
 * Whether a note counts its time from the moment it was written. A note
 * waits for a natural break — the end of a programme, a pause, a calm point
 * — so "in five minutes" may be read an hour later and be wrong by then. The
 * clock time stays true: the caller is asked for it instead.
 */
export function saysWhenFromNow(message: string): boolean {
  return FROM_NOW.test(message);
}
export const KEY_ALREADY_USED_TEXT = 'That idempotency key was already used for a different note, so this one was not sent.';

/** What a sent note's answer keeps, to give a retry: its id and its buttons, never its words. */
interface SentNote {
  readonly cardId: string;
  readonly fromName: string;
  readonly replies: readonly string[];
}

export function registerSendNoteToTv(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  sendCard: SendCard,
  now: () => number = Date.now,
): void {
  mcpServer.registerTool(
    'send_note_to_tv',
    {
      title: 'Send a note to the television',
      description:
        'Puts a note on the household television, in the name of the family member who is signed in. The resident answers with one of three buttons. ' +
        'Pass `replies`: the keys of the two replies from this list that best answer this particular note — ' +
        `${Object.entries(REPLY_CHOICES).map(([key, text]) => `${key} ("${text}")`).join(', ')}. ` +
        `A third is added: "${DECLINE_REPLY}" when either reply answers a question or a plan (${ANSWERING_REPLIES.join(', ')}), otherwise one more kind word. ` +
        'Without two keys from the list the standing three are used. Replies cannot be written, only chosen. ' +
        'The answer says which replies were offered (`replies`). ' +
        'A note that says the member will ring or come at a time is best answered talk_then and thank_you. ' +
        'Send the member\'s own words. The note waits for a natural break, so a time counted from now ("in five minutes") is refused: ask for the clock time instead. ' +
        'A time already given as a clock time stays as the member said it ("tonight at seven", "at 2 pm"); a 24-hour time ("14:00") is said on her television as "2 pm". ' +
        'Sending the same note again within two minutes does not send it twice: the answer is the first one, with `repeated`. ' +
        'A client that retries may pass `idempotencyKey`, the same for every try of one note.',
      inputSchema: {
        message: z.string().min(1).max(MAX_CARD_DETAIL_CHARS).describe(`The note text, at most ${MAX_CARD_DETAIL_CHARS} characters: it is read on a television, in large type, in full.`),
        replies: z.array(z.string()).max(3).optional().describe('The keys of two replies from the list in this tool’s description, e.g. ["yes_please", "another_day"].'),
        idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional().describe('Optional. The same value on every retry of one note (8 to 128 letters, digits, ".", "_", ":" or "-"): the note is sent once.'),
      },
      outputSchema: OUTPUT,
      annotations: WRITES,
    },
    // The sender is never an argument. The resident trusts the name on the
    // card, so it is the name of the person the resident allowed — a note
    // cannot be made to say it came from somebody else.
    withFriendlyErrors(gated(ctx, async (allowed, { message: written, replies, idempotencyKey }: { message: string; replies?: string[] | undefined; idempotencyKey?: string | undefined }) => {
      // Read when it is read, not when it is sent: a time counted from now would be wrong by then.
      if (saysWhenFromNow(written)) return say(NOTE_SAYS_WHEN_TEXT);
      // "14:00" is said as she says it, "2 pm"; nothing else in the note changes (contracts clock.ts).
      const message = saidOnHerClock(written);
      const fromName = allowed.membership.name;
      const asked = callKey({ message, replies });
      // INV-6: a retried call, or the same note sent again at once, is one note.
      const claim = await claimOnce<SentNote>(ddb, {
        householdId: ctx.householdId,
        userId: ctx.userId,
        tool: 'send_note_to_tv',
        ...(idempotencyKey === undefined
          ? { key: asked, windowMs: SAME_NOTE_WINDOW_MS }
          : { key: `key:${idempotencyKey}`, asked, windowMs: IDEMPOTENCY_KEY_WINDOW_MS }),
        now: now(),
      });
      if (!claim.first) {
        if (idempotencyKey !== undefined && !claim.sameCall) return say(KEY_ALREADY_USED_TEXT);
        if (!claim.answer) return say(NOTE_ON_ITS_WAY_TEXT);
        const sent = claim.answer;
        return theirOwnWords(data({ sent: true, cardId: sent.cardId, fromName: sent.fromName, message, replies: [...sent.replies], repeated: true }), [message]);
      }

      const card = buildMessageCard({
        householdId: ctx.householdId,
        correlationId: randomUUID(),
        fromName,
        message,
        replies,
        now: now(),
      });
      try {
        await sendCard(card, { sentBy: ctx.userId });
      } catch (err) {
        // Not sent, so a retry must be able to send it.
        await claim.release().catch(() => {});
        throw err;
      }
      const offered = card.card.type === 'MESSAGE' ? card.card.suggestedReplies : [];
      // Kept for a retry; a failure to keep it only means a retry is told the note is on its way.
      await claim.keep({ cardId: card.id, fromName, replies: offered }).catch((err: unknown) =>
        console.error(JSON.stringify({ level: 'error', msg: 'once_not_kept', tool: 'send_note_to_tv', err: err instanceof Error ? err.name : 'unknown' })));
      return theirOwnWords(data({ sent: true, cardId: card.id, fromName, message, replies: offered }), [message]);
    })),
  );
}
