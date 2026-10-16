/**
 * MCP tool: get_watch_together — "Did Mum say yes to the film?", and, while
 * it is on, where the film is.
 *
 * Reads the newest session the family member who is signed in made, or the
 * one they name: whether the resident has answered, whether it is time to
 * sit down, and — between her press on "Start the film" and the end of the
 * session — where her film is, for a player that follows it. The family app
 * asks every couple of seconds while a seat is taken; an assistant asks once.
 *
 * The session is kept on the server and nowhere else, so a question asked
 * on Tuesday is answered from what was arranged on Monday.
 *
 * Shown to the person who made the session and to nobody else
 * (watchSession.ts mySession): another member of the circle is told there
 * is nothing, because for them there is not.
 *
 * One read and no model call, inside Alexa+'s 500ms budget (§9.3).
 */
import { z } from 'zod';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { answerSchema, READS, data, say } from './result.js';
import { NOTHING_ASKED, describeWatch, mySession, mySessions, WATCH_VIEW } from './watchSession.js';

/** What this tool's structured content is (result.ts `answerSchema`): built once, for every request. */
const OUTPUT = answerSchema(WATCH_VIEW);

export function registerGetWatchTogether(mcpServer: McpServer, ddb: DynamoDBClient, ctx: ToolContext, now: () => number = Date.now): void {
  mcpServer.registerTool(
    'get_watch_together',
    {
      title: 'Watching a film together',
      description:
        'Returns the film the family member who is signed in has asked to watch with the resident (the newest, or the one named by `sessionId`), and its `state`: ' +
        '"invited" (on the television, not yet answered; withdraw_watch_invitation takes it back, and calls off one already accepted), "declined", "withdrawn" (taken back before it was answered: another can be sent), "cancelled" (called off by the family member after the resident had said yes; the television says so), "accepted" (with `canSitDown`: whether it is time yet), ' +
        '"ready" (they have sat down and the television is waiting for the resident to start the film), "passed" (the resident chose not to, when it came to it), ' +
        '"watching" (with `playback`: where the resident’s film is, for a player that follows it), ' +
        '"stopped" (the resident started the film and left it before the end: nothing is followed any more, and another invitation can be sent), ' +
        '"watched" (the film reached its end: the one `question`, the `answers` that can be given, and who has answered what) or "over" (the time passed). ' +
        'Once the question has been asked, `answersInWords` is the sentence to say for who answered what: say it as it stands. `yourAnswer` is the signed-in family member’s own answer, and `theirAnswer` is the resident’s answer: never say one as the other’s. ' +
        'Sit down with join_watch_together and answer with answer_watch_together, passing this `sessionId`.',
      inputSchema: {
        sessionId: z.string().min(1).max(64).optional().describe('The `sessionId` of one session. Without it, the newest.'),
      },
      outputSchema: OUTPUT,
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async (allowed, { sessionId }: { sessionId?: string | undefined }) => {
      const session = sessionId === undefined
        ? (await mySessions(ddb, ctx.householdId, ctx.userId))[0]
        : await mySession(ddb, ctx.householdId, ctx.userId, sessionId);
      const residentName = allowed.household.residentName;
      return session ? data(describeWatch(session, now(), residentName)) : say(NOTHING_ASKED(residentName));
    })),
  );
}
