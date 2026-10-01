/**
 * MCP tool: get_replies — "Has Mum replied?" M3's way back to the family.
 *
 * The resident answers a note with one button on the television. The
 * device route records the reply on the note's own CARD# item, in the
 * words Wick offered (services/edge-device/lambda/note-reply.mjs). This
 * reads those items back. It is one Query and no model call, so it stays
 * inside Alexa+'s 500ms budget (§9.3).
 *
 * No Guardian class applies. A reply is something the resident chose to
 * send to the family, by pressing it, so passing it on is the point.
 */
import { QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { QueuedCard } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HOUSEHOLD_ID } from '../auth.js';
import { withFriendlyErrors } from './errors.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NOTES = 5;

export interface NoteReply {
  readonly from: string;
  /** null for a voice note with no transcript. */
  readonly message: string | null;
  readonly sentAt: number;
  readonly reply: { readonly text: string; readonly at: number } | null;
}

export async function loadNoteReplies(ddb: DynamoDBClient, householdId: string, now: number): Promise<NoteReply[]> {
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

    const text = item.replyText?.S;
    const at = item.repliedAt?.N;
    notes.push({
      from: queued.card.fromName,
      message: queued.card.transcript ?? null,
      sentAt: queued.queuedAt,
      reply: text !== undefined && at !== undefined ? { text, at: Number(at) } : null,
    });
  }

  return notes.sort((a, b) => b.sentAt - a.sentAt).slice(0, MAX_NOTES);
}

export function registerGetReplies(mcpServer: McpServer, ddb: DynamoDBClient, now: () => number = Date.now): void {
  mcpServer.registerTool(
    'get_replies',
    {
      title: 'Replies from the television',
      description: "Returns this week's notes sent to the household television, newest first, each with the resident's one-button reply or null if they haven't replied yet.",
      inputSchema: {},
    },
    withFriendlyErrors(async () => {
      const notes = await loadNoteReplies(ddb, HOUSEHOLD_ID, now());
      if (notes.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No notes have been sent to the television this week.' }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ notes }) }] };
    }),
  );
}
