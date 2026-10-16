/**
 * MCP tool: answer_reach_request — "I'm ringing now."
 *
 * The resident asked to be rung, or said hello (get_reach_request). This
 * puts the answer of somebody who was asked onto her television, under
 * their name, on the same card that told her who was asked.
 *
 * INV-2: the answer reaches the television through the sender the server
 * was given (server.ts AppDeps.sendCard), which in a deployment is
 * egress.ts's sendToDevice and nothing else.
 *
 * The answer is a key from REACH_ANSWERS (packages/contracts reach.ts),
 * never a sentence, for the reason answer_door_request gives. The name is
 * never an argument either: it is the name of the person the resident
 * allowed.
 *
 * Only somebody the request has reached can answer it; anyone else is told
 * what they would be told if there were no request. The first answer is the
 * answer — the write is conditional — so she is never shown two people
 * each saying they are ringing now, and whoever comes second is told what
 * was said. The three-minute timer finds the answer and asks nobody further
 * (services/agent agents/reach/due.ts).
 *
 * It does not ring anyone. The telephone call is the person's own to make.
 */
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { REACH_ANSWERS, answersFor, buildReachCard, wasAsked, type QueuedCard, type ReachAnswer, type ReachRequest } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { NOT_ASKED, firstName, reachesOf, stillOpen } from './get_reach_request.js';
import { ANSWER_OUTCOME, WRITES, data, say, type AnswerOutcome } from './result.js';

const ANSWER_KEYS = Object.keys(REACH_ANSWERS) as [ReachAnswer, ...ReachAnswer[]];

const alreadyAnswered = (answer: NonNullable<ReachRequest['answer']>): string => `${firstName(answer.byName)} has already answered: “${REACH_ANSWERS[answer.key]}”`;

/** Who is answering: the household and the member of a verified token (INV-8), by the names the resident allowed (INV-9). */
export interface ReachAnswerer {
  readonly householdId: string;
  readonly userId: string;
  /** The member's name as the circle holds it; the television shows its first word. */
  readonly memberName: string;
  readonly residentName: string;
}

/**
 * Puts one chosen answer to a request to ring on the resident's television
 * — the whole of what the tool does, and of what a press on a family
 * member's own television does (accounts/familyTelevision.ts). Whoever
 * calls it has already asked whether the resident allows this person; this
 * decides whether they were asked, and the first answer is the answer.
 */
export async function answerReachRequest(
  ddb: DynamoDBClient,
  who: ReachAnswerer,
  requestId: string,
  answer: ReachAnswer,
  sendCard: (card: QueuedCard) => Promise<void>,
  now: number,
): Promise<AnswerOutcome> {
  const { householdId, userId, residentName } = who;
  const reaches = reachesOf(ddb);
  const request = await reaches.load(householdId, requestId);
  // Not asked, and no such request, are one answer: see get_reach_request.
  if (!request || !wasAsked(request, userId)) return { shown: false, say: NOT_ASKED(residentName) };
  // INV-6: this person's own answer, asked again (a retried call), is the answer they gave.
  const theirs = (given: ReachRequest['answer']): given is NonNullable<ReachRequest['answer']> => given?.by === userId && given.key === answer;
  if (theirs(request.answer)) return { shown: true, by: request.answer.byName, text: REACH_ANSWERS[answer] };
  if (request.answer) return { shown: false, say: alreadyAnswered(request.answer) };
  if (!answersFor(request.kind).includes(answer)) {
    return { shown: false, say: `That answer does not fit what ${residentName} asked. Choose one of: ${answersFor(request.kind).map((key) => `${key} ("${REACH_ANSWERS[key]}")`).join(', ')}.` };
  }
  if (!stillOpen(request, now)) {
    return { shown: false, say: `That was a while ago, so the answer would not mean much on the television now. A telephone call or a note will still reach ${residentName}.` };
  }

  const given = { key: answer, by: userId, byName: firstName(who.memberName), at: now };
  if (!(await reaches.answer(householdId, requestId, given))) {
    // Someone answered in the moment between the read and the write.
    const settled = await reaches.load(householdId, requestId);
    if (theirs(settled?.answer)) return { shown: true, by: settled!.answer!.byName, text: REACH_ANSWERS[answer] };
    return { shown: false, say: settled?.answer ? alreadyAnswered(settled.answer) : NOT_ASKED(residentName) };
  }

  await sendCard(buildReachCard({ ...request, answer: given }, now));
  return { shown: true, by: given.byName, text: REACH_ANSWERS[answer] };
}

/** What this tool's structured content is (result.ts `answerSchema`): built once, for every request. */
const OUTPUT = ANSWER_OUTCOME;

export function registerAnswerReachRequest(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  sendCard: (card: QueuedCard) => Promise<void>,
  now: () => number = Date.now,
): void {
  mcpServer.registerTool(
    'answer_reach_request',
    {
      title: 'Answer a request to ring',
      description:
        'Answers the resident’s request to be rung (or their hello), in the name of the person who is signed in. The answer is shown on the television under their name. ' +
        'Pass the `requestId` from get_reach_request and `answer`: the key of one of the `answers` it offered — ' +
        `${Object.entries(REACH_ANSWERS).map(([key, text]) => `${key} ("${text}")`).join(', ')}. ` +
        'An answer cannot be written, only chosen. This does NOT make the telephone call: the person must ring themselves. ' +
        'Only use it when the person has said they are ringing, will ring, or wants to say hello back — never on their behalf.',
      inputSchema: {
        requestId: z.string().regex(/^\d{13,16}$/).describe('The `requestId` get_reach_request returned for the request being answered.'),
        answer: z.enum(ANSWER_KEYS).describe('The key of the chosen answer, e.g. "now".'),
      },
      outputSchema: OUTPUT,
      annotations: WRITES,
    },
    withFriendlyErrors(gated(ctx, async (allowed, { requestId, answer }: { requestId: string; answer: ReachAnswer }) => {
      const outcome = await answerReachRequest(
        ddb,
        { householdId: ctx.householdId, userId: ctx.userId, memberName: allowed.membership.name, residentName: allowed.household.residentName },
        requestId,
        answer,
        sendCard,
        now(),
      );
      return outcome.shown ? data({ shown: true, by: outcome.by, text: outcome.text }) : say(outcome.say);
    }, { neighbour: true })),
  );
}
