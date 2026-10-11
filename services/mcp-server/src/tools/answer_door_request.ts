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
import { PutItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { DOOR_ANSWERS, type CardPatch, type DoorAnswer } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { NOBODY_ASKED, describeLook, loadLookRow } from './get_door_request.js';
import { WRITES, data, say } from './result.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

const ANSWER_KEYS = Object.keys(DOOR_ANSWERS) as [DoorAnswer, ...DoorAnswer[]];

const alreadyAnswered = (answer: { by: string; text: string }): string => `${answer.by} has already answered: "${answer.text}"`;

/** The name the resident reads on the card: a first name, as the door card's own button used. */
const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

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
      annotations: WRITES,
    },
    withFriendlyErrors(gated(ctx, async (allowed, { requestId, answer }: { requestId: string; answer: DoorAnswer }) => {
      const residentName = allowed.household.residentName;
      const row = await loadLookRow(ddb, ctx.householdId, requestId);
      const request = row ? await describeLook(ddb, ctx.householdId, row, now()) : undefined;
      if (!row || !request) return say(NOBODY_ASKED(residentName));
      if (request.state === 'answered') return say(alreadyAnswered(request.answer));
      if (request.state === 'gone') {
        return say(`The door card has already gone from the television, so an answer cannot be shown on it. A note or a telephone call will still reach ${residentName}.`);
      }

      const by = firstName(allowed.membership.name);
      try {
        await ddb.send(new PutItemCommand({
          TableName: TABLE,
          Item: {
            ...row,
            answerKey: { S: answer },
            answeredAt: { N: String(now()) },
            answeredBy: { S: ctx.userId },
            answeredByName: { S: by },
          },
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(answeredAt)',
        }));
      } catch (err) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
        // Someone answered in the moment between the read and the write.
        const latest = await loadLookRow(ddb, ctx.householdId, requestId);
        const settled = latest ? await describeLook(ddb, ctx.householdId, latest, now()) : undefined;
        return say(settled?.state === 'answered' ? alreadyAnswered(settled.answer) : NOBODY_ASKED(residentName));
      }

      const text = DOOR_ANSWERS[answer];
      await sendPatch({ cardId: request.requestId, notice: `${by} says: ${text}` }, ctx.householdId);
      return data({ shown: true, by, text });
    })),
  );
}
