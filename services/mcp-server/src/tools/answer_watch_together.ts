/**
 * MCP tool: answer_watch_together — what the family member thought of it.
 *
 * When the film reaches its credits each of the two is asked one question.
 * The resident answers on the television (edge-device
 * watch-together.mjs); this is the family member's answer, which is put on
 * her television under their name.
 *
 * The answer is a key from WATCH_ANSWERS (packages/contracts watch.ts),
 * never a sentence — answer_door_request.ts says why: what is shown under a
 * daughter's name must be something only Wick wrote. One answer each: the
 * write is conditional, and it is an UpdateItem, not a rewrite of the row,
 * because the resident may be answering on the television at the same
 * moment.
 *
 * INV-2: the card goes through the sender the server was given
 * (server.ts AppDeps.sendCard).
 */
import { z } from 'zod';
import { UpdateItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { WATCH_ACTIONS, WATCH_ANSWERS, type QueuedCard, type WatchAnswer } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { WRITES, data, say } from './result.js';
import { NOTHING_ASKED, TABLE, answersInWords, mySession, sessionKey, watchCard, type WatchSession } from './watchSession.js';

const ANSWER_KEYS = Object.keys(WATCH_ANSWERS) as [WatchAnswer, ...WatchAnswer[]];

export const NOT_FINISHED_TEXT = 'The film has not reached its end yet.';
const alreadyAnswered = (session: WatchSession): string => `You have already answered: “${WATCH_ANSWERS[session.familyAnswer!]}”`;

/** What became of the answer: on her television under `by`'s name, or the one sentence that says why not. */
export type WatchAnswerOutcome =
  | { readonly shown: true; readonly by: string; readonly text: string; readonly theirAnswer?: string; readonly answersInWords: string }
  | { readonly shown: false; readonly say: string };

/**
 * Puts the family member's answer to the one question on the resident's
 * television — the whole of what the tool does, and of what the same press
 * on that person's own television does (accounts/familyTelevision.ts).
 * Whoever calls it has already asked whether the resident allows this
 * person; a session is only ever found for the one who made it.
 */
export async function answerWatchTogether(
  ddb: DynamoDBClient,
  who: { readonly householdId: string; readonly userId: string; readonly residentName: string },
  sessionId: string,
  answer: WatchAnswer,
  sendCard: (card: QueuedCard) => Promise<void>,
  at: number,
): Promise<WatchAnswerOutcome> {
  const { householdId, userId, residentName } = who;
  const no = (say: string): WatchAnswerOutcome => ({ shown: false, say });
  const session = await mySession(ddb, householdId, userId, sessionId);
  if (!session) return no(NOTHING_ASKED(residentName));
  if (session.askedAt === undefined) return no(NOT_FINISHED_TEXT);
  if (session.familyAnswer) return no(alreadyAnswered(session));
  if (at >= session.closesAt) return no(`It is too late to put an answer on the television. A note will still reach ${residentName}.`);

  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: sessionKey(householdId, sessionId),
      UpdateExpression: 'SET familyAnswer = :answer, familyAnsweredAt = :at',
      ConditionExpression: 'attribute_exists(askedAt) AND attribute_not_exists(familyAnswer)',
      ExpressionAttributeValues: { ':answer': { S: answer }, ':at': { N: String(at) } },
    }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    // Answered in the moment between the read and the write, from another window.
    const settled = await mySession(ddb, householdId, userId, sessionId);
    return no(settled?.familyAnswer ? alreadyAnswered(settled) : NOT_FINISHED_TEXT);
  }

  const by = session.invitedByName;
  const text = WATCH_ANSWERS[answer];
  await sendCard(watchCard({
    kind: 'answer',
    householdId,
    session,
    headline: `${by} says: “${text}”`,
    detail: `About ${session.programmeTitle}, which you watched together.`,
    actions: [{ id: WATCH_ACTIONS.ok, label: 'OK', kind: 'primary' }],
    now: at,
  }));

  const theirAnswer = session.residentAnswer ? WATCH_ANSWERS[session.residentAnswer] : undefined;
  return { shown: true, by, text, ...(theirAnswer ? { theirAnswer } : {}), answersInWords: answersInWords(residentName, text, theirAnswer) };
}

export function registerAnswerWatchTogether(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  sendCard: (card: QueuedCard) => Promise<void>,
  now: () => number = Date.now,
): void {
  mcpServer.registerTool(
    'answer_watch_together',
    {
      title: 'Say what you thought of the film',
      description:
        'After a film watched together has reached its end, puts the family member’s answer to the one question on the resident’s television, under their name. ' +
        'Pass the `sessionId` from get_watch_together and `answer`: the key of one of these — ' +
        `${Object.entries(WATCH_ANSWERS).map(([key, text]) => `${key} ("${text}")`).join(', ')}. ` +
        'An answer cannot be written, only chosen, and only by the person who watched: never answer on their behalf. ' +
        'In what comes back, `text` is the signed-in family member’s own answer (shown under the name in `by`), and `theirAnswer` is the resident’s answer, there only if the resident has answered. `answersInWords` is the sentence to say for who answered what: say it as it stands.',
      inputSchema: {
        sessionId: z.string().min(1).max(64).describe('The `sessionId` get_watch_together returned.'),
        answer: z.enum(ANSWER_KEYS).describe('The key of the chosen answer, e.g. "loved_it".'),
      },
      annotations: WRITES,
    },
    withFriendlyErrors(gated(ctx, async (allowed, { sessionId, answer }: { sessionId: string; answer: WatchAnswer }) => {
      const outcome = await answerWatchTogether(
        ddb,
        { householdId: ctx.householdId, userId: ctx.userId, residentName: allowed.household.residentName },
        sessionId,
        answer,
        sendCard,
        now(),
      );
      if (!outcome.shown) return say(outcome.say);
      return data({ shown: true, by: outcome.by, text: outcome.text, ...(outcome.theirAnswer ? { theirAnswer: outcome.theirAnswer } : {}), answersInWords: outcome.answersInWords });
    })),
  );
}
