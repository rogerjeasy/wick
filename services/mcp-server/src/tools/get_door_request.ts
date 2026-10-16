/**
 * MCP tool: get_door_request — "Has Mum asked me to look at the door?"
 *
 * When a stranger is at the door, the resident can press "Ask Sarah to
 * look" on the door card. The Door agent files that as one LOOK# row
 * (services/agent door/askFamily.ts). This reads the newest one back, with
 * the picture and the sentence from the door card itself while the card is
 * still on the television.
 *
 * The resident chose to send this, by pressing it. It is also all that is
 * sent. The picture is the one on the resident's own television, it is
 * Ring's address for it and is stored nowhere else (INV-3), and it is
 * handed out only while the question is open — not after an answer, and
 * not once the card has gone.
 *
 * Her pressing it does not make the vision model's sentence safe to pass
 * on. "A woman in a nurse's uniform holding a medication box." is about
 * her health, and the family is never told that (INV-4). So the sentence
 * passes the Guardian first (guardian.ts `familyText`), and one it cannot
 * clear is left out — exactly as when the model was unsure and wrote none,
 * which already happens: nothing in the answer says a sentence was held
 * back. Her own television still shows it. The picture is hers to show.
 *
 * Two reads and no model call, inside Alexa+'s 500ms budget (§9.3).
 */
import { GetItemCommand, QueryCommand, type AttributeValue, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DOOR_ANSWERS, DOOR_CARD_TTL_MS, DOOR_LOOK_SK_PREFIX, isDoorAnswer, type QueuedCard } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { answerSchema, READS, data, say } from './result.js';
import { z } from 'zod';
import { familyText } from '../guardian.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

type Item = Record<string, AttributeValue>;

interface Asked {
  readonly requestId: string;
  readonly askedAt: number;
}

export type DoorRequest =
  | (Asked & {
      readonly state: 'waiting';
      readonly line: string;
      readonly description?: string;
      readonly pictureUrl?: string;
      readonly answers: readonly { readonly key: string; readonly text: string }[];
    })
  | (Asked & { readonly state: 'answered'; readonly answer: { readonly by: string; readonly text: string; readonly at: number } })
  /** The door card left the television before anyone answered. */
  | (Asked & { readonly state: 'gone' });

export const NOBODY_ASKED = (residentName: string): string => `${residentName} hasn't asked anyone to look at the door.`;

const ANSWERS = Object.entries(DOOR_ANSWERS).map(([key, text]) => ({ key, text }));

/** The LOOK# row of one door card, or undefined. Consistent: an answer is decided on it. */
export async function loadLookRow(ddb: DynamoDBClient, householdId: string, requestId: string): Promise<Item | undefined> {
  const res = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `${DOOR_LOOK_SK_PREFIX}${requestId}` } },
    ConsistentRead: true,
  }));
  return res.Item;
}

/** What one LOOK# row says now, read against the door card it is about. */
export async function describeLook(ddb: DynamoDBClient, householdId: string, row: Item, now: number): Promise<DoorRequest | undefined> {
  const requestId = row.cardId?.S;
  const askedAt = Number(row.askedAt?.N);
  if (!requestId || !Number.isFinite(askedAt)) return undefined;
  const asked: Asked = { requestId, askedAt };

  const answerKey = row.answerKey?.S;
  if (isDoorAnswer(answerKey) && row.answeredAt?.N) {
    return { ...asked, state: 'answered', answer: { by: row.answeredByName?.S ?? 'Someone', text: DOOR_ANSWERS[answerKey], at: Number(row.answeredAt.N) } };
  }

  const stored = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${requestId}` } },
    ConsistentRead: true,
  }));
  const raw = stored.Item?.data?.S;
  const queued = raw ? (JSON.parse(raw) as QueuedCard) : undefined;
  // The card's own clock, as the television keeps it — not the row's copy.
  const expiresAt = queued ? queued.expiresAt ?? queued.queuedAt + DOOR_CARD_TTL_MS : 0;
  if (!queued || queued.card.type !== 'DOOR' || now >= expiresAt) return { ...asked, state: 'gone' };

  const { line, imageRef } = queued.card;
  // For the family, through the Guardian: a sentence it cannot clear is left out, as one the model never wrote.
  const description = queued.card.description ? familyText(queued.card.description, 'door.description') : undefined;
  return {
    ...asked,
    state: 'waiting',
    line,
    ...(description ? { description } : {}),
    ...(imageRef ? { pictureUrl: imageRef } : {}),
    answers: ANSWERS,
  };
}

/** The newest question about the door, or undefined when nobody has been asked. */
export async function loadDoorRequest(ddb: DynamoDBClient, householdId: string, now: number): Promise<DoorRequest | undefined> {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: DOOR_LOOK_SK_PREFIX } },
  }));
  // A handful at most: one per door card, each gone after a day.
  const newest = (res.Items ?? []).sort((a, b) => Number(b.askedAt?.N ?? 0) - Number(a.askedAt?.N ?? 0))[0];
  return newest ? describeLook(ddb, householdId, newest, now) : undefined;
}

/** What this tool's structured content is (result.ts `answerSchema`): built once, for every request. */
const OUTPUT = answerSchema({
  requestId: z.string(),
  askedAt: z.number(),
  state: z.enum(['waiting', 'answered', 'gone']),
  line: z.string().optional().describe('"waiting": the door card’s line.'),
  description: z.string().optional().describe('"waiting": what the picture shows, when Wick is sure.'),
  pictureUrl: z.string().optional(),
  answers: z.array(z.strictObject({ key: z.string(), text: z.string() })).optional().describe('"waiting": what can be answered.'),
  answer: z.strictObject({ by: z.string(), text: z.string(), at: z.number() }).optional().describe('"answered": who answered, and what.'),
});

export function registerGetDoorRequest(mcpServer: McpServer, ddb: DynamoDBClient, ctx: ToolContext, now: () => number = Date.now): void {
  mcpServer.registerTool(
    'get_door_request',
    {
      title: 'A question from the front door',
      description:
        'When someone unexpected is at the door, the resident can press "Ask … to look" on the television. Returns the newest such question: ' +
        '`state` "waiting" (with the door card’s line, a one-sentence `description` and a `pictureUrl` when they have arrived, and the `answers` that can be given), ' +
        '"answered" (who answered and what), or "gone" (the door card left the television first). ' +
        'Answer a waiting question with answer_door_request, passing this `requestId`.',
      inputSchema: {},
      outputSchema: OUTPUT,
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async (allowed) => {
      const request = await loadDoorRequest(ddb, ctx.householdId, now());
      return request ? data(request) : say(NOBODY_ASKED(allowed.household.residentName));
    }, { neighbour: true })),
  );
}
