/**
 * MCP tool: arrange_visit — "The plumber is coming Thursday at ten — let Mum
 * know."
 *
 * A visit errand (packages/contracts errand.ts). The member who is signed in
 * arranges it, after saying yes to it in the family app; from then on code
 * carries it out, over days, as a Step Functions execution
 * (infra/errand.asl.json, services/agent agents/errand):
 *
 *   the door is told whom to expect — a roster entry, so the door card says
 *     "This looks like the plumber" and "Sarah arranged this visit";
 *   she is reminded at a natural break — on the morning, or an hour before;
 *   the member is told whether the door rang around then, or nobody came.
 *
 * Here the errand and the roster entry are written in one transaction, and
 * the execution is started, named by the errand so that starting it twice
 * is starting it once. A start that fails leaves nothing standing: the
 * errand is marked failed and the door is not told.
 *
 * Who is coming is the member's own words, trimmed, at most forty
 * characters, and must clear the Guardian: those words come back to the
 * family in get_errands and on the door card. The day and the time are read
 * as expect_visit reads them, in the household's time zone, with its limits
 * — and a visit may be as soon as two minutes ahead, so that a judge can
 * arrange one "in five minutes" and watch the whole errand run.
 *
 * It does not put a note on her television by itself: the reminder comes on
 * the day. An assistant asked to "let Mum know" calls send_note_to_tv too.
 */
import { z } from 'zod';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executionInput } from '@wick/agent';
import { ERRAND_LIMITS, REMINDER_CHOICES, isErrandOpen, newErrandId, remindAtFor, type Errand, type ReminderChoice } from '@wick/contracts';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { answerSchema, data, say } from './result.js';
import { callKey, claimOnce } from './once.js';
import { localToUtc } from './when.js';
import { EXPECT_VISIT_BAD_TIME_TEXT, EXPECT_VISIT_PAST_TEXT, EXPECT_VISIT_TOO_FAR_TEXT } from './expect_visit.js';
import { IDEMPOTENCY_KEY_WINDOW_MS, SAME_NOTE_WINDOW_MS } from './send_note_to_tv.js';
import { familyText } from '../guardian.js';
import {
  ARRANGE_BAD_WHO_TEXT,
  ARRANGE_TOO_MANY_TEXT,
  ARRANGE_TOO_SOON_TEXT,
  ARRANGE_WHO_NOT_SHARED_TEXT,
  ERRAND_VIEW,
  ERRANDS_UNAVAILABLE_TEXT,
  HOUSEHOLD_TZ,
  errandView,
  errandsOf,
  type ErrandMachine,
} from './errands.js';

export const ARRANGE_ON_ITS_WAY_TEXT = 'That visit is already being arranged.';
export const ARRANGE_KEY_ALREADY_USED_TEXT = 'That idempotency key was already used for a different visit, so this one was not arranged.';

/** Not read-only, not destructive, and the same call twice arranges once. The family app asks the member first. */
export const ARRANGES = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const OUTPUT = answerSchema({
  arranged: z.literal(true),
  errand: ERRAND_VIEW,
  repeated: z.literal(true).optional().describe('The same visit was arranged moments ago, and was not arranged again: this is that one.'),
});

interface Arranged {
  readonly errandId: string;
}

interface Args {
  readonly who: string;
  readonly date: string;
  readonly time: string;
  readonly reminder?: ReminderChoice | undefined;
  readonly tellMe?: boolean | undefined;
  readonly idempotencyKey?: string | undefined;
}

export function registerArrangeVisit(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  machine: ErrandMachine | undefined,
  now: () => number = Date.now,
): void {
  const errands = errandsOf(ddb);
  mcpServer.registerTool(
    'arrange_visit',
    {
      title: 'Arrange a visit',
      description:
        'Arranges a visit by somebody else — "the plumber is coming Thursday at ten" — and carries it out over the days that follow: ' +
        'the door is told whom to expect (the card on the resident’s television says it looks like them, and who arranged it), ' +
        'she is reminded on her television at a calm moment (`reminder`: "morning_of" at eight on the day, "hour_before", or "none"), ' +
        'and, with `tellMe`, the family member is notified whether the doorbell rang around then or nobody came. ' +
        '`who` is who is coming, in a few words ("the plumber", "Dave from the council"), never a title or what they come for. ' +
        'The time is in the household’s local time, at least two minutes ahead. Read how it went with get_errands. ' +
        'It does not put a note on her television now: use send_note_to_tv as well if she should know today.',
      inputSchema: {
        who: z.string().max(200).describe(`Who is coming, at most ${ERRAND_LIMITS.whoMaxChars} characters: "the plumber", "Dave".`),
        date: z.string().describe('The day of the visit, YYYY-MM-DD.'),
        time: z.string().describe('The time of the visit in 24-hour HH:MM, in the household’s local time.'),
        reminder: z.enum(REMINDER_CHOICES).optional().describe('When to remind her: "morning_of" (the default), "hour_before" or "none".'),
        tellMe: z.boolean().optional().describe('Whether to notify the family member how it went. True unless said otherwise.'),
        idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional().describe('Optional. The same value on every retry of one visit: it is arranged once.'),
      },
      outputSchema: OUTPUT,
      annotations: ARRANGES,
    },
    withFriendlyErrors(gated(ctx, async (allowed, args: Args) => {
      if (!machine) return say(ERRANDS_UNAVAILABLE_TEXT);

      const who = args.who.trim().replace(/\s+/g, ' ');
      if (who.length === 0 || who.length > ERRAND_LIMITS.whoMaxChars) return say(ARRANGE_BAD_WHO_TEXT);
      if (!familyText(who, 'errand.who')) return say(ARRANGE_WHO_NOT_SHARED_TEXT);

      const at = localToUtc(args.date, args.time, HOUSEHOLD_TZ);
      if (at === undefined) return say(EXPECT_VISIT_BAD_TIME_TEXT);
      const asked = now();
      if (at < asked) return say(EXPECT_VISIT_PAST_TEXT);
      if (at < asked + ERRAND_LIMITS.minLeadMs) return say(ARRANGE_TOO_SOON_TEXT);
      if (at > asked + ERRAND_LIMITS.maxLeadMs) return say(EXPECT_VISIT_TOO_FAR_TEXT);

      const reminder = args.reminder ?? 'morning_of';
      const tellMe = args.tellMe ?? true;
      const residentName = allowed.household.residentName;

      // INV-6: a retried call, or the same visit arranged again at once, is one errand.
      const call = callKey({ who, date: args.date, time: args.time, reminder, tellMe });
      const claim = await claimOnce<Arranged>(ddb, {
        householdId: ctx.householdId,
        userId: ctx.userId,
        tool: 'arrange_visit',
        ...(args.idempotencyKey === undefined
          ? { key: call, windowMs: SAME_NOTE_WINDOW_MS }
          : { key: `key:${args.idempotencyKey}`, asked: call, windowMs: IDEMPOTENCY_KEY_WINDOW_MS }),
        now: asked,
      });
      if (!claim.first) {
        if (args.idempotencyKey !== undefined && !claim.sameCall) return say(ARRANGE_KEY_ALREADY_USED_TEXT);
        const first = claim.answer ? await errands.get(ctx.householdId, claim.answer.errandId) : undefined;
        if (!first) return say(ARRANGE_ON_ITS_WAY_TEXT);
        return data({ arranged: true, errand: errandView(first, residentName), repeated: true });
      }

      try {
        const open = (await errands.list(ctx.householdId)).filter((e) => isErrandOpen(e.status));
        if (open.length >= ERRAND_LIMITS.maxOpenPerHousehold) {
          await claim.release();
          return say(ARRANGE_TOO_MANY_TEXT);
        }

        const remindAt = remindAtFor(reminder, at, HOUSEHOLD_TZ, asked);
        const errand: Errand = {
          errandId: newErrandId(),
          householdId: ctx.householdId,
          // From the token, never the request: nobody arranges a visit in somebody else's name.
          createdBy: ctx.userId,
          createdByName: allowed.membership.name,
          who,
          at,
          windowMinutes: ERRAND_LIMITS.windowMinutes,
          ...(remindAt === undefined ? {} : { remindAt }),
          tellMe,
          status: 'planned',
          createdAt: asked,
        };
        if (!(await errands.create(errand))) throw new Error('errand id already taken');

        let executionArn: string;
        try {
          executionArn = await machine.start(errand.errandId, executionInput(errand, asked));
        } catch (err) {
          // Nothing is left standing that nobody is carrying out: the door is not told, and the errand says it failed.
          await errands.move(ctx.householdId, errand.errandId, ['planned'], 'failed').catch(() => false);
          await errands.forgetRoster(ctx.householdId, errand.errandId).catch(() => {});
          throw err;
        }
        await errands.setExecution(ctx.householdId, errand.errandId, executionArn);

        // Kept for a retry; a failure to keep it only means a retry is told the visit is on its way.
        await claim.keep({ errandId: errand.errandId }).catch((err: unknown) =>
          console.error(JSON.stringify({ level: 'error', msg: 'once_not_kept', tool: 'arrange_visit', err: err instanceof Error ? err.name : 'unknown' })));
        console.log(JSON.stringify({ level: 'info', msg: 'errand_arranged', errandId: errand.errandId, reminder, tellMe }));
        return data({ arranged: true, errand: errandView(errand, residentName) });
      } catch (err) {
        // Not arranged, so a retry must be able to arrange it.
        await claim.release().catch(() => {});
        throw err;
      }
    })),
  );
}
