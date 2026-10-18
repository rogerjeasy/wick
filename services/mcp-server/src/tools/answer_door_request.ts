/**
 * MCP tool: answer_door_request — the second pair of eyes answers.
 *
 * The resident asked someone to look at the door (get_door_request). This
 * puts that person's answer on the door card, under their name, while the
 * resident is still deciding whether to open it.
 *
 * INV-2: the answer reaches the television through the sender the server
 * was given (server.ts AppDeps.sendPatch), which in a deployment is
 * egress.ts's sendPatchToDevice and nothing else.
 *
 * The answer is a key from DOOR_ANSWERS (packages/contracts door.ts), never
 * a sentence: see the note there. The name is never an argument either. It
 * is the name of the person the resident allowed, as on a note
 * (send_note_to_tv.ts).
 *
 * The first answer is the answer. Two people asked at once cannot leave the
 * resident reading "it's all right" and then "don't open the door": the
 * write is conditional, and whoever comes second is told what was said.
 */
import { GetItemCommand, PutItemCommand, type AttributeValue, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { DOOR_ANSWERS, doorActionsAfterAnswer, type CardAction, type CardPatch, type DoorAnswer, type QueuedCard } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { NOBODY_ASKED, describeLook, loadLookRow } from './get_door_request.js';
import { ANSWER_OUTCOME, WRITES, data, say, type AnswerOutcome } from './result.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

const ANSWER_KEYS = Object.keys(DOOR_ANSWERS) as [DoorAnswer, ...DoorAnswer[]];

const alreadyAnswered = (answer: { by: string; text: string }): string => `${answer.by} has already answered: "${answer.text}"`;

/** The name the resident reads on the card: a first name, as the door card's own button used. */
const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/** Who is answering: the household and the member of a verified token (INV-8), by the names the resident allowed (INV-9). */
export interface DoorAnswerer {
  readonly householdId: string;
  readonly userId: string;
  /** The member's name as the circle holds it; the card shows its first word. */
  readonly memberName: string;
  readonly residentName: string;
}

/**
 * Puts one chosen answer on the door card — the whole of what the tool
 * does, and of what a press on a family member's own television does
 * (accounts/familyTelevision.ts). Whoever calls it has already asked
 * whether the resident allows this person; this decides only whether the
 * question is still open, and the first answer is the answer.
 */
export async function answerDoorRequest(
  ddb: DynamoDBClient,
  who: DoorAnswerer,
  requestId: string,
  answer: DoorAnswer,
  sendPatch: (patch: CardPatch, householdId: string) => Promise<void>,
  now: number,
): Promise<AnswerOutcome> {
  const { householdId, residentName } = who;
  const row = await loadLookRow(ddb, householdId, requestId);
  const request = row ? await describeLook(ddb, householdId, row, now) : undefined;
  if (!row || !request) return { shown: false, say: NOBODY_ASKED(residentName) };
  // INV-6: this person's own answer, asked again (a retried call), is the answer they gave — not someone else's.
  const theirs = (held: Record<string, AttributeValue> | undefined): boolean => held?.answeredBy?.S === who.userId && held.answerKey?.S === answer;
  if (request.state === 'answered') return theirs(row) ? { shown: true, by: request.answer.by, text: request.answer.text } : { shown: false, say: alreadyAnswered(request.answer) };
  if (request.state === 'gone') {
    return { shown: false, say: `The door card has already gone from the television, so an answer cannot be shown on it. A note or a telephone call will still reach ${residentName}.` };
  }

  const by = firstName(who.memberName);
  try {
    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        ...row,
        answerKey: { S: answer },
        answeredAt: { N: String(now) },
        answeredBy: { S: who.userId },
        answeredByName: { S: by },
      },
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(answeredAt)',
    }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    // Someone answered in the moment between the read and the write.
    const latest = await loadLookRow(ddb, householdId, requestId);
    const settled = latest ? await describeLook(ddb, householdId, latest, now) : undefined;
    if (settled?.state === 'answered' && theirs(latest)) return { shown: true, by: settled.answer.by, text: settled.answer.text };
    return { shown: false, say: settled?.state === 'answered' ? alreadyAnswered(settled.answer) : NOBODY_ASKED(residentName) };
  }

  const text = DOOR_ANSWERS[answer];
  // Under the answer, the card's own buttons, with "Thank you" where "Not now" was (contracts doorActionsAfterAnswer).
  const actions = await actionsAfterAnswer(ddb, householdId, request.requestId);
  await sendPatch({ cardId: request.requestId, notice: `${by} says: ${text}`, ...(actions ? { actions } : {}) }, householdId);
  return { shown: true, by, text };
}

/**
 * The door card's buttons once it has been answered, from the card as it was
 * sent. Undefined when it cannot be read: the answer still goes on the card,
 * under the buttons it already has.
 */
async function actionsAfterAnswer(ddb: DynamoDBClient, householdId: string, cardId: string): Promise<CardAction[] | undefined> {
  try {
    const stored = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${cardId}` } } }));
    const raw = stored.Item?.data?.S;
    const queued = raw ? (JSON.parse(raw) as QueuedCard) : undefined;
    const actions = queued?.card.type === 'DOOR' ? doorActionsAfterAnswer(queued.card.actions) : [];
    // A card with no buttons left is not given an empty row: it keeps the ones it has.
    return actions.length ? actions : undefined;
  } catch {
    return undefined;
  }
}

/** What this tool's structured content is (result.ts `answerSchema`): built once, for every request. */
const OUTPUT = ANSWER_OUTCOME;

export function registerAnswerDoorRequest(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  sendPatch: (patch: CardPatch, householdId: string) => Promise<void>,
  now: () => number = Date.now,
): void {
  mcpServer.registerTool(
    'answer_door_request',
    {
      title: 'Answer a question from the front door',
      description:
        'Answers the resident’s question about who is at the door, in the name of the family member who is signed in. The answer is shown on the door card on the television at once. ' +
        'Pass the `requestId` from get_door_request and `answer`: the key of one of these — ' +
        `${Object.entries(DOOR_ANSWERS).map(([key, text]) => `${key} ("${text}")`).join(', ')}. ` +
        'An answer cannot be written, only chosen, and only the person who has looked at the picture should choose it: never answer on their behalf.',
      inputSchema: {
        requestId: z.string().min(1).max(64).describe('The `requestId` get_door_request returned for the question being answered.'),
        answer: z.enum(ANSWER_KEYS).describe('The key of the chosen answer, e.g. "dont_open".'),
      },
      outputSchema: OUTPUT,
      annotations: WRITES,
    },
    withFriendlyErrors(gated(ctx, async (allowed, { requestId, answer }: { requestId: string; answer: DoorAnswer }) => {
      const outcome = await answerDoorRequest(
        ddb,
        { householdId: ctx.householdId, userId: ctx.userId, memberName: allowed.membership.name, residentName: allowed.household.residentName },
        requestId,
        answer,
        sendPatch,
        now(),
      );
      return outcome.shown ? data({ shown: true, by: outcome.by, text: outcome.text }) : say(outcome.say);
    }, { neighbour: true })),
  );
}
