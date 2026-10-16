/**
 * MCP tool: get_reach_request — "Did Mum ask for me?"
 *
 * The resident held OK on the remote and asked to be rung, or chose "Just
 * say hello" (packages/contracts reach.ts). The agent plane files that as
 * one REACH# row and tells one person at a time (services/agent agents/
 * reach). This reads the newest request back — for somebody it has reached.
 *
 * What it must never do:
 *
 *   - tell somebody who has not been asked yet that there is a request.
 *     They get the very words given when there is none, and no structure:
 *     her asking reaches people in the order she would ring them, and
 *     nobody learns of it early by asking;
 *   - say who else was asked, how many, or who is next.
 *
 * No Guardian class applies, for the reason get_replies gives: this is
 * something the resident chose to send, by pressing it. It is also all that
 * is sent — that she would like a call, or says hello. Nothing about why.
 *
 * A neighbour may use it (context.ts `gated`): being asked to ring is one of
 * the two things a neighbour is for.
 *
 * One read and no model call, inside Alexa+'s 500ms budget (§9.3). The app
 * calls it by itself to keep its card up to date, so it is not a look
 * (lookIn.ts).
 */
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { REACH_ANSWERS, REACH_OPEN_MS, answersFor, wasAsked, type ReachKind, type ReachRequest } from '@wick/contracts';
import { reachStore, type ReachSend, type ReachStore } from '@wick/agent';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { answerSchema, READS, data, say } from './result.js';
import { z } from 'zod';

const TABLE = process.env.TABLE_NAME ?? 'wick';

interface Asked {
  readonly requestId: string;
  readonly kind: ReachKind;
  readonly askedAt: number;
}

export type ReachForFamily =
  | (Asked & {
      readonly state: 'waiting';
      /** The whole of it in words, to be said as it stands. */
      readonly summary: string;
      readonly answers: readonly { readonly key: string; readonly text: string }[];
    })
  | (Asked & {
      readonly state: 'answered';
      readonly answer: { readonly by: string; readonly text: string; readonly at: number; readonly yours: boolean };
    });

export const NOT_ASKED = (residentName: string): string => `${residentName} hasn’t asked you to ring.`;

export const reachesOf = (ddb: DynamoDBClient): ReachStore => reachStore((command) => ddb.send(command as never) as ReturnType<ReachSend>, TABLE);

/** The first name the resident reads on her television. */
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;

/** Whether an unanswered request can still be answered: for the rest of that day, not for ever. */
export const stillOpen = (request: ReachRequest, now: number): boolean => now - request.askedAt < REACH_OPEN_MS;

/**
 * What a request says to one person — or undefined when it says nothing to
 * them: they have not been asked, or it went unanswered long ago.
 */
export function reachFor(request: ReachRequest | undefined, userId: string, residentName: string, now: number): ReachForFamily | undefined {
  if (!request || !wasAsked(request, userId)) return undefined;
  const asked: Asked = { requestId: request.reachId, kind: request.kind, askedAt: request.askedAt };

  if (request.answer) {
    const { key, by, byName, at } = request.answer;
    return { ...asked, state: 'answered', answer: { by: firstName(byName), text: REACH_ANSWERS[key], at, yours: by === userId } };
  }
  if (!stillOpen(request, now)) return undefined;

  return {
    ...asked,
    state: 'waiting',
    summary: request.kind === 'ring' ? `${residentName} would like you to ring her.` : `${residentName} says hello.`,
    answers: answersFor(request.kind).map((key) => ({ key, text: REACH_ANSWERS[key] })),
  };
}

/** What this tool's structured content is (result.ts `answerSchema`): built once, for every request. */
const OUTPUT = answerSchema({
  requestId: z.string(),
  kind: z.enum(['ring', 'hello']),
  askedAt: z.number(),
  state: z.enum(['waiting', 'answered']),
  summary: z.string().optional().describe('"waiting": the whole of it in words, to be said as it stands.'),
  answers: z.array(z.strictObject({ key: z.string(), text: z.string() })).optional(),
  answer: z.strictObject({ by: z.string(), text: z.string(), at: z.number(), yours: z.boolean() }).optional(),
});

export function registerGetReachRequest(mcpServer: McpServer, ddb: DynamoDBClient, ctx: ToolContext, now: () => number = Date.now): void {
  mcpServer.registerTool(
    'get_reach_request',
    {
      title: 'A request to ring, from the television',
      description:
        'The resident can hold OK on the television’s remote and ask the person signed in to ring them, or just to say hello. Returns the newest such request made of this person: ' +
        '`state` "waiting" (say `summary` as it stands; `answers` are what can be answered), or "answered" (who answered and what; `yours` when it was this person). ' +
        'Use it for "did Mum ask for me", "does she want me to ring", "has Mum been in touch". ' +
        'It is not an emergency signal and carries no reason: never guess at one, and never say anything is wrong. ' +
        'Answer a waiting request with answer_reach_request, passing this `requestId`.',
      inputSchema: {},
      outputSchema: OUTPUT,
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async (allowed) => {
      const residentName = allowed.household.residentName;
      const reach = reachFor(await reachesOf(ddb).latest(ctx.householdId), ctx.userId, residentName, now());
      return reach ? data(reach) : say(NOT_ASKED(residentName));
    }, { neighbour: true })),
  );
}
