/**
 * MCP tool: get_replies — "Has Mum replied?" M3's way back to the family.
 *
 * The resident answers a note with one button on the television. The
 * device route records the reply on the note's own CARD# item, in the
 * words Wick offered (services/edge-device/lambda/note-reply.mjs). This
 * reads those items back. It is one Query and no model call, so it stays
 * inside Alexa+'s 500ms budget (§9.3).
 *
 * A wave (accounts/familyTvWave.ts) is kept under a note's key so that the
 * edge records her press on it, and is left out here: it is not a note
 * anybody wrote.
 *
 * A reply is something the resident chose to send to the family, by
 * pressing it, so passing it on is the point — and it is always one of the
 * sentences Wick offered (send_note_to_tv.ts REPLY_CHOICES), never her own
 * words.
 *
 * A note's words are another matter. They are one family member's, to her:
 * "Is your hip still bad? Did the pension come?" Read back with her answer
 * to everyone in the circle, they would tell the rest of the family about
 * her health and her money (INV-4). So the words are read back to the
 * person who wrote them (`sentBy`, kept on the note's row by egress.ts and
 * never sent to the television), and to nobody else. Everyone else sees
 * that a note was sent, by whom and when, and her reply: `message` is null,
 * for every note of somebody else's, whatever it said. Not only the ones
 * the Guardian would catch — a note left out only when it named her hip
 * would tell the family that it did (the reasoning of INV-10). A note sent
 * before `sentBy` was kept has no writer on record, and is nobody's to read
 * back.
 */
import { QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { QueuedCard } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { READS, data, say } from './result.js';
import { isWaveCardId } from '../accounts/familyTvWave.js';
import { theirOwnWords } from '../guardian.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NOTES = 5;

export interface NoteReply {
  readonly from: string;
  /** The note's words, for the person who wrote them. null for everyone else, and for a voice note with no transcript. */
  readonly message: string | null;
  readonly sentAt: number;
  readonly reply: { readonly text: string; readonly at: number } | null;
}

/** `reader`: the userId of the family member asking. Only their own notes come back with their words. */
export async function loadNoteReplies(ddb: DynamoDBClient, householdId: string, reader: string, now: number): Promise<NoteReply[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: 'CARD#note-' } },
  }));

  const notes: NoteReply[] = [];
  for (const item of res.Items ?? []) {
    const raw = item.data?.S;
    if (!raw) continue;
    const queued = JSON.parse(raw) as QueuedCard;
    if (queued.card.type !== 'MESSAGE' || now - queued.queuedAt > WINDOW_MS) continue;
    // A wave from a family member's own television is a note only in how it travels (accounts/familyTvWave.ts):
    // nobody wrote it, and what she pressed on it is told on that television, not read out as a reply.
    if (isWaveCardId(queued.id)) continue;

    const text = item.replyText?.S;
    const at = item.repliedAt?.N;
    notes.push({
      from: queued.card.fromName,
      message: item.sentBy?.S === reader ? queued.card.transcript ?? null : null,
      sentAt: queued.queuedAt,
      reply: text !== undefined && at !== undefined ? { text, at: Number(at) } : null,
    });
  }

  return notes.sort((a, b) => b.sentAt - a.sentAt).slice(0, MAX_NOTES);
}

export function registerGetReplies(mcpServer: McpServer, ddb: DynamoDBClient, ctx: ToolContext, now: () => number = Date.now): void {
  mcpServer.registerTool(
    'get_replies',
    {
      title: 'Replies from the television',
      description:
        "Returns this week's notes sent to the household television, newest first: who sent each and when, and the resident's one-button reply, or null if they haven't replied yet. " +
        "`message` is the note's words for a note the person asking wrote themselves, and null for everyone else's: a note is between the person who wrote it and the resident.",
      inputSchema: {},
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async () => {
      const notes = await loadNoteReplies(ddb, ctx.householdId, ctx.userId, now());
      if (notes.length === 0) {
        return say('No notes have been sent to the television this week.');
      }
      // Only this reader's own notes carry words (loadNoteReplies): those are theirs to be handed back as written.
      return theirOwnWords(data({ notes }), notes.flatMap((n) => (n.message === null ? [] : [n.message])));
    })),
  );
}
