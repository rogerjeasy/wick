/**
 * MCP tool: withdraw_watch_invitation — "Take the film invitation back."
 *
 * An invitation the resident has not answered sits on their television
 * until three hours after its time, and while it is open no other can be
 * sent (invite_to_watch.ts). Plans change: the person who sent it can take
 * it back. The card leaves the television, the session is settled, and
 * another invitation can be sent at once.
 *
 * Only an invitation still waiting. Once she has said yes it is something
 * she is expecting, and it does not quietly disappear from her side: this
 * tool says so and changes nothing.
 *
 * The session's row is what decides, not the look before it: the write
 * holds only while the row is still `invited`, which is the same condition
 * the edge puts on her yes or no (edge-device watch-together.mjs
 * decisionUpdate). Whichever comes first is what happened, and the other is
 * told so.
 *
 * INV-2: the card is taken off the television through the function the
 * server was given (server.ts AppDeps.withdrawCard), which in a deployment
 * is egress.ts's takeBackFromDevices and nothing else. INV-6: asked twice,
 * it does the same thing twice and answers the same.
 */
import { z } from 'zod';
import { UpdateItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { watchCardId } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { WRITES, data, say } from './result.js';
import { NOTHING_ASKED, TABLE, describeWatch, mySession, mySessions, sessionKey, type WatchView } from './watchSession.js';

export function registerWithdrawWatchInvitation(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  withdrawCard: (householdId: string, cardId: string) => Promise<void>,
  now: () => number = Date.now,
): void {
  mcpServer.registerTool(
    'withdraw_watch_invitation',
    {
      title: 'Take a film invitation back',
      description:
        'Takes back an invitation to watch a film that the family member who is signed in sent with invite_to_watch and the resident has not answered yet (the newest, or the one named by `sessionId`). ' +
        'The invitation leaves the resident’s television, and another can be sent at once. ' +
        'It does not take back an invitation the resident has already said yes to. Use it only when the person asks to cancel, withdraw or take back their invitation.',
      inputSchema: {
        sessionId: z.string().min(1).max(64).optional().describe('The `sessionId` get_watch_together returned. Without it, the newest.'),
      },
      annotations: WRITES,
    },
    withFriendlyErrors(gated(ctx, async (allowed, { sessionId }: { sessionId?: string | undefined }) => {
      const residentName = allowed.household.residentName;
      const at = now();
      const find = async (id: string | undefined) => (id === undefined ? (await mySessions(ddb, ctx.householdId, ctx.userId))[0] : mySession(ddb, ctx.householdId, ctx.userId, id));
      const session = await find(sessionId);
      if (!session) return say(NOTHING_ASKED(residentName));

      /** Why there is nothing to take back — or undefined while there is. */
      const settled = (view: WatchView): string | undefined => {
        if (view.state === 'invited' || view.state === 'withdrawn') return undefined;
        if (view.state === 'declined') return `${residentName} has already said not this time. There is nothing to take back.`;
        if (view.state === 'accepted' || view.state === 'ready' || view.state === 'watching') {
          return `${residentName} has already said yes to ${view.film} on ${view.when}, so it cannot be taken back.`;
        }
        if (view.state === 'over') return `The time for ${view.film} has passed. There is nothing to take back.`;
        return `${view.film} with ${residentName} is already over. There is nothing to take back.`;
      };

      const view = describeWatch(session, at);
      const reason = settled(view);
      if (reason) return say(reason);

      if (view.state === 'invited') {
        try {
          await ddb.send(new UpdateItemCommand({
            TableName: TABLE,
            Key: sessionKey(ctx.householdId, session.sessionId),
            UpdateExpression: 'SET #status = :withdrawn, withdrawnAt = :at',
            // The edge's own condition on her answer: whichever write comes first is what happened.
            ConditionExpression: '#status = :invited',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':withdrawn': { S: 'withdrawn' }, ':invited': { S: 'invited' }, ':at': { N: String(at) } },
          }));
        } catch (err) {
          if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
          // She answered in the moment between the look and the write.
          const answered = await mySession(ddb, ctx.householdId, ctx.userId, session.sessionId);
          const why = answered ? settled(describeWatch(answered, at)) : NOTHING_ASKED(residentName);
          if (why) return say(why);
        }
      }

      // Also when it was taken back a moment ago: a television that missed it the first time is told again.
      await withdrawCard(ctx.householdId, watchCardId('invite', session.sessionId));
      return data({ withdrawn: true, sessionId: session.sessionId, film: view.film, when: view.when });
    })),
  );
}
