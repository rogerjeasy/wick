/**
 * MCP tool: get_errands — "Did the plumber come?"
 *
 * The visits the signed-in member arranged (arrange_visit.ts): those still
 * to come, and those whose window ended in the last seven days, newest
 * first, each with how it stands in one honest sentence (errands.ts
 * `errandSentence`). The door knows that somebody rang and when, not who:
 * "Someone rang at 10:04 am, around when the plumber was expected."
 *
 * Only the member's own. Another member's errand is theirs to be told
 * about, and the execution behind each — and the door's token — are the
 * operator's, never the family's. One Query and no model call.
 */
import { z } from 'zod';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isErrandOpen } from '@wick/contracts';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { READS, answerSchema, data, say } from './result.js';
import { ERRAND_VIEW, errandView, errandsOf, isOverBefore } from './errands.js';
import { zoneOf } from '../accounts/types.js';

const RECENT_MS = 7 * 86_400_000;

export const NO_ERRANDS_TEXT = 'You have no visits arranged, and none in the last week.';

const OUTPUT = answerSchema({
  errands: z.array(ERRAND_VIEW).describe('The visits this member arranged, still to come or from the last seven days, newest first.'),
});

export function registerGetErrands(mcpServer: McpServer, ddb: DynamoDBClient, ctx: ToolContext, now: () => number = Date.now): void {
  const errands = errandsOf(ddb);
  mcpServer.registerTool(
    'get_errands',
    {
      title: 'Visits you arranged',
      description:
        'Lists the visits the signed-in family member arranged with arrange_visit — still to come, or from the last seven days — newest first: ' +
        'who, when, whether the resident has been reminded, and how it went. `said` is one sentence to tell as it stands. ' +
        'A ring in the window is told as somebody ringing around then: the door cannot say who it was. Each has the `errandId` cancel_errand takes.',
      inputSchema: {},
      outputSchema: OUTPUT,
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async (allowed) => {
      const since = now() - RECENT_MS;
      const mine = (await errands.list(ctx.householdId))
        .filter((errand) => errand.createdBy === ctx.userId)
        .filter((errand) => isErrandOpen(errand.status) || !isOverBefore(errand, since));
      if (mine.length === 0) return say(NO_ERRANDS_TEXT);
      return data({ errands: mine.map((errand) => errandView(errand, allowed.household.residentName, zoneOf(allowed.household))) });
    })),
  );
}
