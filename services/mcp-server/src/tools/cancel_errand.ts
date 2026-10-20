/**
 * MCP tool: cancel_errand — "The plumber can't come after all."
 *
 * Calls off a visit the signed-in member arranged (arrange_visit.ts): the
 * errand is marked cancelled first, so that any step of it already on its
 * way does nothing (agents/errand reads the status at every step); the
 * door is no longer told to expect them; and the execution is stopped.
 *
 * Only the member who arranged it may call it off. Anyone else — and an id
 * that is nobody's — is told there is no such visit, in the same words, so
 * the tool says nothing about another member's errands. Calling off a visit
 * already called off is the same answer again; one that is over is over.
 */
import { z } from 'zod';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isErrandOpen } from '@wick/contracts';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { answerSchema, data, say } from './result.js';
import { ERRAND_VIEW, errandView, errandsOf, toItsAuthor, type ErrandMachine } from './errands.js';
import type { HeldErrand } from '@wick/agent';
import { zoneOf } from '../accounts/types.js';

export const ERRAND_NOT_FOUND_TEXT = 'I cannot find a visit you arranged by that. Ask me which visits you have arranged.';
export const ERRAND_ALREADY_OVER_TEXT = 'That visit is over, so there is nothing left to call off.';

/** It takes something away, and the same call twice does it once. The family app asks the member first. */
export const CANCELS = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

const OUTPUT = answerSchema({
  cancelled: z.literal(true),
  errand: ERRAND_VIEW,
});

export function registerCancelErrand(mcpServer: McpServer, ddb: DynamoDBClient, ctx: ToolContext, machine: ErrandMachine | undefined): void {
  const errands = errandsOf(ddb);
  mcpServer.registerTool(
    'cancel_errand',
    {
      title: 'Call off a visit you arranged',
      description:
        'Calls off a visit the signed-in family member arranged with arrange_visit, by its `errandId` from get_errands: ' +
        'the door is no longer told to expect them, and no reminder or notification follows. Only the person who arranged it can call it off.',
      inputSchema: {
        errandId: z.string().max(64).describe('The visit, as get_errands or arrange_visit named it.'),
      },
      outputSchema: OUTPUT,
      annotations: CANCELS,
    },
    withFriendlyErrors(gated(ctx, async (allowed, { errandId }: { errandId: string }) => {
      const residentName = allowed.household.residentName;
      const timeZone = zoneOf(allowed.household);
      // Told in the member's own words: only the author reaches an answer with an errand in it (errands.ts toItsAuthor).
      const calledOff = (errand: HeldErrand) => {
        const view = errandView(errand, residentName, timeZone);
        return toItsAuthor(data({ cancelled: true as const, errand: view }), ctx.userId, [{ errand, view }]);
      };
      const held = await errands.get(ctx.householdId, errandId);
      if (!held || held.createdBy !== ctx.userId) return say(ERRAND_NOT_FOUND_TEXT);
      if (held.status === 'cancelled') return calledOff(held);
      if (!isErrandOpen(held.status)) return say(ERRAND_ALREADY_OVER_TEXT);

      if (!(await errands.move(ctx.householdId, errandId, ['planned', 'reminded', 'waiting'], 'cancelled', {}, { forgetToken: true }))) {
        // A step moved it on in the meantime: answer for how it stands now.
        const now = await errands.get(ctx.householdId, errandId);
        if (now?.status === 'cancelled') return calledOff(now);
        return say(ERRAND_ALREADY_OVER_TEXT);
      }
      await errands.forgetRoster(ctx.householdId, errandId);
      if (held.executionArn && machine) {
        // The errand is already cancelled, and every step reads that first: a stop that fails is logged, not a failed answer.
        await machine.stop(held.executionArn).catch((err: unknown) =>
          console.error(JSON.stringify({ level: 'error', msg: 'errand_not_stopped', errandId, err: err instanceof Error ? err.name : 'unknown' })));
      }
      return calledOff({ ...held, status: 'cancelled' });
    })),
  );
}
