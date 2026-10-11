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
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PutItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PROGRAMMES, WATCH_ACTIONS, programmeById, watchWindow, type QueuedCard } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { WRITES, data, say } from './result.js';
import { localToUtc } from './when.js';
import { HOUSEHOLD_TZ, TABLE, describeWatch, firstName, invitationItem, isOpen, mySessions, watchCard, whenInWords, type WatchSession } from './watchSession.js';

const DAY_MS = 86_400_000;
/** "Now" said a few minutes ago is still now. */
const JUST_NOW_MS = 10 * 60_000;
/** Beyond this an invitation is a hope, not a plan. */
const MAX_DAYS_AHEAD = 60;

export const INVITE_BAD_TIME_TEXT = 'I need a day and a time for that, like Sunday at three.';
export const INVITE_PAST_TEXT = 'That time has already passed. Which day and time did you mean?';
export const INVITE_TOO_FAR_TEXT = 'That is more than two months away. Ask nearer the time.';

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
        'Only one invitation can be open at a time.',
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
      const open = (await mySessions(ddb, ctx.householdId, ctx.userId)).map((s) => describeWatch(s, at)).find((view) => isOpen(view.state));
      if (open) {
        const answered = open.state === 'invited' ? 'It is still waiting for an answer.' : `${residentName} said yes.`;
        return say(`You have already asked ${residentName} to watch ${open.film} on ${open.when}. ${answered}`);
      }

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
      await ddb.send(new PutItemCommand({
        TableName: TABLE,
        Item: invitationItem(ctx.householdId, session, film.creditsPositionMs),
        ConditionExpression: 'attribute_not_exists(pk)',
      }));

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
