/**
 * MCP tool: join_watch_together — the family member sits down.
 *
 * At the time that was arranged, the person who sent the invitation takes
 * their seat. That puts one card on the resident's television: who is
 * ready, which film, and the button that starts it. Her press on that
 * button is what lets this person's player follow hers — so the card says,
 * in plain words, exactly what pressing it shares (the rule in
 * packages/contracts/src/watch.ts). "Not now" is on the same card.
 *
 * Told once. Sitting down again, or looking again, sends her nothing more:
 * the conditional write below is what makes the card unrepeatable.
 *
 * INV-2: the card goes through the sender the server was given
 * (server.ts AppDeps.sendCard).
 */
import { z } from 'zod';
import { UpdateItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { WATCH_ACTIONS, type QueuedCard } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { WRITES, data, say } from './result.js';
import { NOTHING_ASKED, TABLE, WITHDRAWN_TEXT, describeWatch, mySession, sessionKey, watchCard } from './watchSession.js';

export function registerJoinWatchTogether(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  sendCard: (card: QueuedCard) => Promise<void>,
  now: () => number = Date.now,
): void {
  mcpServer.registerTool(
    'join_watch_together',
    {
      title: 'Sit down to watch together',
      description:
        'The family member who is signed in sits down to the film they arranged with invite_to_watch. Pass the `sessionId` from get_watch_together. ' +
        'It works from half an hour before the arranged time, and only if the resident said yes. The resident’s television then says they are ready, with one button that starts the film; ' +
        'from that press, get_watch_together returns where the resident’s film is. Returns the session as get_watch_together does. ' +
        'Only the person who will be watching should sit down: never do it on their behalf.',
      inputSchema: {
        sessionId: z.string().min(1).max(64).describe('The `sessionId` get_watch_together returned.'),
      },
      annotations: WRITES,
    },
    withFriendlyErrors(gated(ctx, async (allowed, { sessionId }: { sessionId: string }) => {
      const residentName = allowed.household.residentName;
      const at = now();
      const session = await mySession(ddb, ctx.householdId, ctx.userId, sessionId);
      if (!session) return say(NOTHING_ASKED(residentName));

      const view = describeWatch(session, at);
      if (view.state === 'invited') return say(`${residentName} hasn't answered the invitation yet. It is on the television.`);
      if (view.state === 'declined') return say(`${residentName} said not this time.`);
      if (view.state === 'withdrawn') return say(WITHDRAWN_TEXT);
      if (view.state === 'passed') return say(`${residentName} chose not to watch just now.`);
      if (view.state === 'over') return say(`The time for ${view.film} has passed. You can ask again for another day.`);
      if (view.state !== 'accepted') return data(view); // already sat down
      if (!view.canSitDown) {
        return say(`It is not time yet. ${view.film} with ${residentName} is on ${view.when}; you can sit down from half an hour before.`);
      }

      try {
        await ddb.send(new UpdateItemCommand({
          TableName: TABLE,
          Key: sessionKey(ctx.householdId, sessionId),
          UpdateExpression: 'SET joinedAt = :at',
          ConditionExpression: '#status = :accepted AND attribute_not_exists(joinedAt)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':accepted': { S: 'accepted' }, ':at': { N: String(at) } },
        }));
      } catch (err) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
        // Sat down a moment ago, from another window: the television has been told.
        const settled = await mySession(ddb, ctx.householdId, ctx.userId, sessionId);
        return settled ? data(describeWatch(settled, at)) : say(NOTHING_ASKED(residentName));
      }

      const by = session.invitedByName;
      await sendCard(watchCard({
        kind: 'ready',
        householdId: ctx.householdId,
        session,
        headline: `${by} is ready to watch ${session.programmeTitle} with you.`,
        // The press on "Start the film" is the consent, so this is where it is said what it shares.
        detail: `From when you start it, ${by} sees the film as you play it: where you pause, it pauses for ${by} too. Only this film, and only this time.`,
        actions: [
          { id: WATCH_ACTIONS.start, label: 'Start the film', kind: 'primary' },
          { id: WATCH_ACTIONS.notNow, label: 'Not now', kind: 'dismiss' },
        ],
        now: at,
        starts: { programmeId: session.programmeId, followedUntil: session.closesAt },
      }));

      return data(describeWatch({ ...session, joinedAt: at }, at));
    })),
  );
}
