/**
 * MCP tool: expect_visit — "I'm coming on Saturday at three."
 *
 * The family member who is signed in tells the house when they will come.
 * It is filed on the household's roster as one expected moment, under their
 * own name, and that is all it takes for the rest to happen without anyone
 * doing anything more: when the doorbell goes near that time the Door agent
 * matches it exactly as it matches a regular visitor (services/agent/src/
 * agents/door/roster.ts), the card on the television says who it looks
 * like, and the visit is in the week's story as theirs.
 *
 * It takes a day and a time, and nothing else. The name is the one the
 * resident allowed on the television (the membership), never one from the
 * request: nobody can announce a visit as somebody else (INV-8's rule,
 * applied to a name). It does not tell the resident anything by itself —
 * that is what send_note_to_tv is for, and an assistant asked to "let Mum
 * know I'm coming" is expected to do both.
 */
import { z } from 'zod';
import { PutItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { RosterEntry } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { isSharedWithFamily, loadHouseholdPolicy } from './get_resident_shared_view.js';
import { loadRoster } from './list_regular_visitors.js';
import { announcedVisitSk, memberPersonId } from '../accounts/announcedVisits.js';
import { answerSchema, WRITES, data, say } from './result.js';
import { localToUtc } from './when.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';
/** Where "three o'clock" is three o'clock. The same default as the Narrator's. */
const HOUSEHOLD_TZ = process.env.WICK_HOUSEHOLD_TZ ?? 'Europe/London';

const DAY_MS = 86_400_000;
/** A ring this long either side of the time given still looks like them: people are early, and late. */
export const EXPECTED_WINDOW_MIN = 60;
/** Beyond this a visit is a hope, not a plan. */
const MAX_DAYS_AHEAD = 60;
/** The roster forgets the visit by itself (the table's `ttl`), once it can no longer be matched or asked about. */
const FORGET_AFTER_MS = 2 * DAY_MS;

export const EXPECT_VISIT_BAD_TIME_TEXT = 'I need a day and a time for that, like Saturday at three.';
export const EXPECT_VISIT_PAST_TEXT = 'That time has already passed. Which day and time did you mean?';
export const EXPECT_VISIT_TOO_FAR_TEXT = 'That is more than two months away. Tell me nearer the time and I will let the door know.';

const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

export interface ExpectedVisitAnswer {
  readonly expected: true;
  readonly name: string;
  readonly at: number;
  readonly windowMinutes: number;
  /** Regular visitors whose usual days include that one — empty when the resident keeps who visits private. */
  readonly alsoExpectedThatDay: readonly string[];
}

/** What this tool's structured content is (result.ts `answerSchema`): built once, for every request. */
const OUTPUT = answerSchema({
  expected: z.literal(true),
  name: z.string(),
  at: z.number(),
  windowMinutes: z.number(),
  alsoExpectedThatDay: z.array(z.string()).describe('Regular visitors whose usual days include that one; empty when the resident keeps who visits private.'),
});

export function registerExpectVisit(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  now: () => Date = () => new Date(),
): void {
  mcpServer.registerTool(
    'expect_visit',
    {
      title: 'Say when you will visit',
      description:
        'Tells the house that the family member who is signed in will visit at a given day and time (the household’s local time). ' +
        'When the doorbell rings within an hour of it, the card on the resident’s television says it looks like them. ' +
        'Returns who else usually comes that day, where the resident shares that. It does not tell the resident: use send_note_to_tv as well if they should know.',
      inputSchema: {
        date: z.string().describe('The day of the visit, YYYY-MM-DD.'),
        time: z.string().describe('The time of the visit in 24-hour HH:MM, in the household’s local time.'),
      },
      outputSchema: OUTPUT,
      annotations: WRITES,
    },
    withFriendlyErrors(gated(ctx, async (allowed, { date, time }: { date: string; time: string }) => {
      const at = localToUtc(date, time, HOUSEHOLD_TZ);
      if (at === undefined) return say(EXPECT_VISIT_BAD_TIME_TEXT);
      const nowMs = now().getTime();
      if (at < nowMs) return say(EXPECT_VISIT_PAST_TEXT);
      if (at > nowMs + MAX_DAYS_AHEAD * DAY_MS) return say(EXPECT_VISIT_TOO_FAR_TEXT);

      const entry: RosterEntry = {
        personId: memberPersonId(ctx.userId),
        name: allowed.membership.name,
        expectedOnce: { at, windowMin: EXPECTED_WINDOW_MIN },
      };
      // Who else comes that day is who visits, by name — the PRESENCE class,
      // gated exactly as list_regular_visitors and did_visitor_come gate it.
      // A resident who keeps that private still lets this member announce
      // their own visit; they are just not told who else is due.
      const dayCode = DAY_CODES[new Date(at).getUTCDay()]!;
      const namesShared = isSharedWithFamily('PRESENCE', await loadHouseholdPolicy(ddb, ctx.householdId));
      const alsoExpectedThatDay = namesShared
        ? (await loadRoster(ddb, ctx.householdId))
            .filter((p) => !p.expectedOnce && (p.expectedPattern?.split(' ')[0]?.split(',') ?? []).includes(dayCode))
            .map((p) => p.name)
        : [];

      await ddb.send(new PutItemCommand({
        TableName: TABLE,
        Item: {
          pk: { S: `HH#${ctx.householdId}` },
          // One visit a day each: saying it again for the same day moves it.
          sk: { S: announcedVisitSk(ctx.userId, date) },
          data: { S: JSON.stringify(entry) },
          ttl: { N: String(Math.floor((at + FORGET_AFTER_MS) / 1000)) },
        },
      }));

      const answer: ExpectedVisitAnswer = { expected: true, name: entry.name, at, windowMinutes: EXPECTED_WINDOW_MIN, alsoExpectedThatDay };
      return data(answer);
    })),
  );
}
