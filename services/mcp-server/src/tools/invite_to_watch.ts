/**
 * MCP tool: invite_to_watch — "Ask Mum to watch a film with me on Sunday at three."
 *
 * Watch together (packages/contracts/src/watch.ts) begins here: an
 * invitation on the resident's television, in the name of the family member
 * who is signed in, answered there with one button. Nothing is shared by
 * asking, and nothing by her saying yes — only her later press on "Start
 * the film" does that (join_watch_together.ts, and the rule in watch.ts).
 *
 * INV-2: the card reaches the television through the sender the server was
 * given (server.ts AppDeps.sendCard), which in a deployment is egress.ts's
 * sendToDevice and nothing else.
 *
 * The film is one of Wick's own (packages/contracts/src/programmes.ts) and
 * the name is the one the resident allowed, never one from the request
 * (send_note_to_tv.ts says why). One invitation at a time each: a
 * television that asked twice would be nagging, and "no" is an answer.
 *
 * That limit is kept by the write, not by looking first. The invitation and
 * the member's "latest invitation" row (watchSession.ts latestKey) are
 * written in one transaction, on the condition that the row still names the
 * invitation that was just read and found settled. A second invitation sent
 * in the same moment read the same row, loses that condition, and is told
 * what the first one asked.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GetItemCommand, TransactWriteItemsCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PROGRAMMES, WATCH_ACTIONS, programmeById, watchWindow, type QueuedCard } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { WRITES, data, say } from './result.js';
import { localToUtc } from './when.js';
import { HOUSEHOLD_TZ, TABLE, describeWatch, firstName, invitationItem, isOpen, latestKey, mySession, watchCard, whenInWords, type WatchSession, type WatchView } from './watchSession.js';

const DAY_MS = 86_400_000;
/** "Now" said a few minutes ago is still now. */
const JUST_NOW_MS = 10 * 60_000;
/** Beyond this an invitation is a hope, not a plan. */
const MAX_DAYS_AHEAD = 60;

export const INVITE_BAD_TIME_TEXT = 'I need a day and a time for that, like Sunday at three.';
export const INVITE_PAST_TEXT = 'That time has already passed. Which day and time did you mean?';
export const INVITE_TOO_FAR_TEXT = 'That is more than two months away. Ask nearer the time.';
export const INVITE_TRY_AGAIN_TEXT = 'That did not go through. Ask again.';

const PROGRAMME_IDS = PROGRAMMES.map((p) => p.id) as [string, ...string[]];

export function registerInviteToWatch(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  sendCard: (card: QueuedCard) => Promise<void>,
  now: () => number = Date.now,
): void {
  mcpServer.registerTool(
    'invite_to_watch',
    {
      title: 'Ask to watch a film together',
      description:
        'Invites the resident to watch one of Wick’s films with the family member who is signed in, at a day and time (the household’s local time). ' +
        'The invitation appears on the resident’s television at the next natural break and is answered there with one button; get_watch_together says what was answered, on any later day. ' +
        `The films: ${PROGRAMMES.map((p) => `${p.id} ("${p.title}", ${p.line})`).join(', ')}. ` +
        'Watching together means the family member’s screen follows the resident’s film from their own home: the resident holds the remote, and there is no camera or microphone. ' +
        'Only one invitation can be open at a time; withdraw_watch_invitation takes back one that has not been answered, or calls off one the resident said yes to.',
      inputSchema: {
        programme: z.enum(PROGRAMME_IDS).describe('The id of the film, e.g. "sintel".'),
        date: z.string().describe('The day to watch, YYYY-MM-DD.'),
        time: z.string().describe('The time to watch in 24-hour HH:MM, in the household’s local time.'),
      },
      annotations: WRITES,
    },
    withFriendlyErrors(gated(ctx, async (allowed, { programme, date, time }: { programme: string; date: string; time: string }) => {
      const film = programmeById(programme);
      const startsAt = localToUtc(date, time, HOUSEHOLD_TZ);
      if (!film || startsAt === undefined) return say(INVITE_BAD_TIME_TEXT);
      const at = now();
      if (startsAt < at - JUST_NOW_MS) return say(INVITE_PAST_TEXT);
      if (startsAt > at + MAX_DAYS_AHEAD * DAY_MS) return say(INVITE_TOO_FAR_TEXT);

      const residentName = allowed.household.residentName;
      const guardKey = latestKey(ctx.householdId, ctx.userId);
      /** The last invitation this person sent, by id, and what it is if it still has something ahead of it. */
      const latest = async (): Promise<{ seen: string | undefined; open: WatchView | undefined }> => {
        const guard = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: guardKey, ConsistentRead: true }));
        const seen = guard.Item?.sessionId?.S;
        const session = seen ? await mySession(ddb, ctx.householdId, ctx.userId, seen) : undefined;
        const view = session ? describeWatch(session, at, residentName) : undefined;
        return { seen, open: view && isOpen(view.state) ? view : undefined };
      };
      const alreadyAsked = (open: WatchView): string => {
        const answered = open.state === 'invited' ? 'It is still waiting for an answer.' : `${residentName} said yes.`;
        return `You have already asked ${residentName} to watch ${open.film} on ${open.when}. ${answered}`;
      };

      const before = await latest();
      if (before.open) return say(alreadyAsked(before.open));

      const session: WatchSession = {
        sessionId: randomUUID(),
        programmeId: film.id,
        programmeTitle: film.title,
        startsAt,
        closesAt: watchWindow(startsAt).closesAt,
        invitedBy: ctx.userId,
        invitedByName: firstName(allowed.membership.name),
        createdAt: at,
        status: 'invited',
      };
      const item = invitationItem(ctx.householdId, session, film.creditsPositionMs);
      try {
        await ddb.send(new TransactWriteItemsCommand({
          TransactItems: [
            { Put: { TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(pk)' } },
            {
              Put: {
                TableName: TABLE,
                Item: { ...guardKey, sessionId: { S: session.sessionId }, ttl: item.ttl! },
                // Still naming the invitation that was read above — or still absent, if there was none.
                ...(before.seen === undefined
                  ? { ConditionExpression: 'attribute_not_exists(pk)' }
                  : { ConditionExpression: 'sessionId = :seen', ExpressionAttributeValues: { ':seen': { S: before.seen } } }),
              },
            },
          ],
        }));
      } catch (err) {
        if ((err as { name?: string }).name !== 'TransactionCanceledException') throw err;
        // Another invitation from this person was written in the moment between the look and the write.
        const now = await latest();
        return say(now.open ? alreadyAsked(now.open) : INVITE_TRY_AGAIN_TEXT);
      }

      const by = session.invitedByName;
      const when = whenInWords(startsAt, HOUSEHOLD_TZ);
      await sendCard(watchCard({
        kind: 'invite',
        householdId: ctx.householdId,
        session,
        headline: `${by} would like to watch a film with you.`,
        // What saying yes means, said before it is said.
        detail: `${film.title}, on ${when}. ${by} would watch along from home and see the film as you play it. You hold the remote.`,
        actions: [
          { id: WATCH_ACTIONS.accept, label: 'Yes, let’s.', kind: 'primary' },
          { id: WATCH_ACTIONS.decline, label: 'Not this time.', kind: 'secondary' },
        ],
        now: at,
      }));

      return data({ invited: true, sessionId: session.sessionId, film: film.title, startsAt, when, fromName: by });
    })),
  );
}
