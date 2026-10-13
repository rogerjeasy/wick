/**
 * MCP tool: withdraw_watch_invitation — "Take the film invitation back", and
 * "I can't make the film after all."
 *
 * Plans change. The person who sent an invitation to watch a film can undo
 * it, and what that means depends on where the resident is with it:
 *
 *   - not answered yet: the invitation is taken back. The card leaves the
 *     television and nothing is said — an invitation that is gone asks
 *     nothing of her;
 *   - she said yes, and the film has not been started: it is called off,
 *     and her television says so, in the name of the person who asked. She
 *     is expecting the film; it must not quietly disappear from her side.
 *
 * Once she has started the film there is nothing to call off: the person
 * watching along can only stop watching, and she holds the remote.
 *
 * Either way the session is settled, so another invitation can be sent at
 * once (invite_to_watch.ts).
 *
 * The session's row is what decides, not the look before it. Each write
 * holds only on the condition the edge puts on her own press (edge-device
 * watch-together.mjs): an invitation can be answered, and taken back, only
 * while it is `invited`; a film can be started, and called off, only while
 * it is `accepted` and not started. Whichever write comes first is what
 * happened, and this tool looks again and acts on that.
 *
 * INV-2: cards leave the television, and reach it, through the functions
 * the server was given (server.ts AppDeps.withdrawCard and sendCard), which
 * in a deployment are egress.ts's and nothing else. INV-6: asked twice, it
 * answers the same — and she is told once (`toldAt`).
 */
import { z } from 'zod';
import { UpdateItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { WATCH_ACTIONS, watchCardId, type QueuedCard } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { WRITES, data, say } from './result.js';
import { NOTHING_ASKED, TABLE, describeWatch, mySession, mySessions, sessionKey, watchCard, type WatchSession } from './watchSession.js';

/** How often her press can win the write before this stops looking again. Once is enough: a session moves one way. */
const LOOKS = 3;

export function registerWithdrawWatchInvitation(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  withdrawCard: (householdId: string, cardId: string) => Promise<void>,
  sendCard: (card: QueuedCard) => Promise<void>,
  now: () => number = Date.now,
): void {
  mcpServer.registerTool(
    'withdraw_watch_invitation',
    {
      title: 'Take a film invitation back, or call the film off',
      description:
        'Undoes an invitation to watch a film that the family member who is signed in sent with invite_to_watch (the newest, or the one named by `sessionId`). ' +
        'If the resident has not answered, the invitation leaves their television and nothing is said. ' +
        'If the resident said yes and the film has not been started, the film is called off and the resident’s television says that the family member cannot make it after all. ' +
        'Either way another invitation can be sent at once. A film already started cannot be called off. ' +
        'Returns `told`: whether the resident’s television was told. Use it only when the person asks to cancel, withdraw, call off or take back, or says they cannot make it.',
      inputSchema: {
        sessionId: z.string().min(1).max(64).optional().describe('The `sessionId` get_watch_together returned. Without it, the newest.'),
      },
      annotations: WRITES,
    },
    withFriendlyErrors(gated(ctx, async (allowed, { sessionId }: { sessionId?: string | undefined }) => {
      const residentName = allowed.household.residentName;
      const at = now();
      const first = sessionId === undefined ? (await mySessions(ddb, ctx.householdId, ctx.userId))[0] : await mySession(ddb, ctx.householdId, ctx.userId, sessionId);
      if (!first) return say(NOTHING_ASKED(residentName));

      const key = sessionKey(ctx.householdId, first.sessionId);
      /** Writes on a condition. False when the row had moved on by then. */
      const write = async (input: { update: string; condition: string; values: Record<string, { S: string } | { N: string }> }): Promise<boolean> => {
        try {
          await ddb.send(new UpdateItemCommand({
            TableName: TABLE,
            Key: key,
            UpdateExpression: input.update,
            ConditionExpression: input.condition,
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: input.values,
          }));
          return true;
        } catch (err) {
          if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
          return false;
        }
      };

      let session: WatchSession | undefined = first;
      for (let look = 0; look < LOOKS && session; look += 1, session = await mySession(ddb, ctx.householdId, ctx.userId, first.sessionId)) {
        const view = describeWatch(session, at, residentName);
        const done = (told: boolean) => data({ withdrawn: true, told, sessionId: view.sessionId, film: view.film, when: view.when });

        if (view.state === 'declined') return say(`${residentName} has already said not this time. There is nothing to take back.`);
        if (view.state === 'passed') return say(`${residentName} chose not to watch just now. There is nothing to take back.`);
        if (view.state === 'over') return say(`The time for ${view.film} has passed. There is nothing to take back.`);
        if (view.state === 'watching') return say(`${view.film} has already been started on the television, so it cannot be called off.`);
        if (view.state === 'stopped' || view.state === 'watched') return say(`${view.film} with ${residentName} is already over. There is nothing to take back.`);

        if (view.state === 'invited') {
          // The edge's own condition on her answer.
          const taken = await write({
            update: 'SET #status = :withdrawn, withdrawnAt = :at',
            condition: '#status = :invited',
            values: { ':withdrawn': { S: 'withdrawn' }, ':invited': { S: 'invited' }, ':at': { N: String(at) } },
          });
          if (!taken) continue; // she answered in that moment: look again
        }
        if (view.state === 'invited' || view.state === 'withdrawn') {
          // Also when it was taken back a moment ago: a television that missed it the first time is told again.
          await withdrawCard(ctx.householdId, watchCardId('invite', view.sessionId));
          return done(false);
        }

        if (view.state === 'accepted' || view.state === 'ready') {
          // The edge's own condition on "Start the film", turned round: only while nothing has been started.
          const called = await write({
            update: 'SET #status = :cancelled, cancelledAt = :at',
            condition: '#status = :accepted AND attribute_not_exists(startedAt)',
            values: { ':cancelled': { S: 'cancelled' }, ':accepted': { S: 'accepted' }, ':at': { N: String(at) } },
          });
          if (!called) continue; // she started it in that moment: look again
        } else if (session.toldAt !== undefined) {
          // Called off before, and she was told then: once is enough.
          return done(true);
        }

        // Called off — now, or a moment ago without the television having been told.
        // The card that was waiting for her to start the film has nothing left to start.
        if (session.joinedAt !== undefined) await withdrawCard(ctx.householdId, watchCardId('ready', view.sessionId));
        const by = session.invitedByName;
        await sendCard(watchCard({
          kind: 'cancelled',
          householdId: ctx.householdId,
          session,
          headline: `${by} cannot make the film after all.`,
          detail: `${view.film}, on ${view.when}, is off. ${by} can ask you again for another time.`,
          actions: [{ id: WATCH_ACTIONS.ok, label: 'All right', kind: 'primary' }],
          now: at,
        }));
        // Best kept, not required: without it a second asking would tell her again, which is the lesser fault.
        await write({ update: 'SET toldAt = :at', condition: '#status = :cancelled', values: { ':cancelled': { S: 'cancelled' }, ':at': { N: String(at) } } });
        return done(true);
      }

      return say(session ? 'That did not go through. Ask again.' : NOTHING_ASKED(residentName));
    })),
  );
}
