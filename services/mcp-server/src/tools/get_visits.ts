/**
 * MCP tool: get_visits — "Did Maria come this week, and did Mum confirm it?"
 *
 * The visit, witnessed (packages/contracts visit.ts). The door notes when a
 * regular visitor came and when somebody was next seen leaving; the
 * resident is then asked, on her own television, whether that is right.
 * Her "Yes, that's right" is what makes a visit one she confirmed. This
 * reads those rows back: who came, on which day, the times the doorbell
 * noted, and whether she has confirmed each.
 *
 * What it must never do (the reasoning of INV-10):
 *
 *   - tell a visit she said was not right from one she has not answered, or
 *     has not been asked about. To the family a visit is confirmed or it is
 *     not, in one word and one field. Whether she disputed one is hers to
 *     tell, through "Shall I tell Sarah?" (services/agent agents/visit/
 *     answer.ts), and it then arrives by get_whats_different like anything
 *     else she chose to pass on. So nothing here carries when she was
 *     asked, what she answered or when: `forFamily` copies the fields it
 *     names and no others.
 *   - give a reason, or a judgement. A visit that is not confirmed means
 *     only that.
 *
 * Who visits, by name, is PRESENCE: when the resident keeps that to
 * herself the whole answer is withheld and nothing is read, exactly as
 * did_visitor_come does. A neighbour is refused by `gated`: this is about
 * the house, not the door.
 *
 * The times are what the doorbell noted, at the house's own clock. They
 * are the door's best reading — not a clinical record and not a bill.
 *
 * One GetItem (the policy) and one bounded Query, no model call, inside
 * Alexa+'s 500ms budget (§9.3). It asks after the visitors, not after the
 * resident, so it is not a look (lookIn.ts).
 */
import { z } from 'zod';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { clockTime, type Visit } from '@wick/contracts';
import { visitStore, type VisitSend } from '@wick/agent';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { FAMILY_REFUSAL_TEXT, isSharedWithFamily, loadHouseholdPolicy } from './get_resident_shared_view.js';
import { withFriendlyErrors } from './errors.js';
import { answerSchema, READS, data, say } from './result.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';
/** Where the house is: the same default as the card she is asked on (services/agent agents/door/actionLambda.ts). */
const HOUSEHOLD_TZ = process.env.WICK_HOUSEHOLD_TZ ?? 'Europe/London';

const DAY_MS = 86_400_000;
export const DEFAULT_VISIT_DAYS = 7;
export const MAX_VISIT_DAYS = 31;

export interface VisitForFamily {
  /** The roster's id, as list_regular_visitors gives it. */
  readonly personId: string;
  readonly name: string;
  /** YYYY-MM-DD, where the house is. */
  readonly date: string;
  /** "Tuesday". */
  readonly day: string;
  /** "9:02 am". */
  readonly arrived: string;
  /** "9:47 am". Absent when nobody was seen leaving. */
  readonly left?: string;
  readonly arrivedAt: number;
  readonly leftAt?: number;
  /** The resident herself said this is right. False says only that she has not. */
  readonly confirmed: boolean;
}

export interface VisitsForFamily {
  readonly days: number;
  /** Newest first. */
  readonly visits: readonly VisitForFamily[];
  readonly confirmedCount: number;
  /** Whose word a confirmed visit stands on. */
  readonly residentName: string;
  /** The whole of it in words, to be said as it stands. */
  readonly summary: string;
  /** A demo home's visits: nobody made them (AGENTS.md, the demo home). */
  readonly simulated?: true;
}

const visitsOf = (ddb: DynamoDBClient) => visitStore((command) => ddb.send(command as never) as ReturnType<VisitSend>, TABLE);

/**
 * One visit as the family is given it. Every field is named here, so that
 * a field added to the row later — or the three it already has about her
 * being asked — cannot reach the family by being carried along.
 */
export function forFamily(visit: Visit, timeZone: string): VisitForFamily {
  return {
    personId: visit.personId,
    name: visit.name,
    date: new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(visit.arrivedAt),
    day: new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(visit.arrivedAt),
    arrived: clockTime(visit.arrivedAt, timeZone),
    ...(visit.leftAt === undefined ? {} : { left: clockTime(visit.leftAt, timeZone) }),
    arrivedAt: visit.arrivedAt,
    ...(visit.leftAt === undefined ? {} : { leftAt: visit.leftAt }),
    confirmed: visit.answer === 'confirmed',
  };
}

const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const lastDays = (days: number): string => (days === 1 ? 'in the last day' : `in the last ${days} days`);

/**
 * The answer in one or two sentences. How many came, and how many of those
 * she has confirmed — never why one is not, because Wick is not told and
 * must not guess.
 */
export function visitsSummary(visits: readonly VisitForFamily[], residentName: string, days: number, onePerson: boolean): string {
  const count = visits.length;
  if (count === 0) return `No visits by ${onePerson ? 'that visitor' : 'a regular visitor'} have been noted ${lastDays(days)}.`;

  const names = new Set(visits.map((visit) => visit.name));
  const came = names.size === 1
    ? `${visits[0]!.name} came ${times(count)} ${lastDays(days)}.`
    : `${count} visits by regular visitors were noted ${lastDays(days)}.`;

  const confirmed = visits.filter((visit) => visit.confirmed).length;
  const them = count === 1 ? 'it' : count === 2 ? 'both of them' : 'all of them';
  const none = count === 1 ? 'it' : count === 2 ? 'either of them' : 'any of them';
  const said =
    confirmed === count ? `${residentName} has confirmed ${them}.`
    : confirmed === 0 ? `${residentName} has not confirmed ${none} yet.`
    : `${residentName} has confirmed ${confirmed} of them.`;
  return `${came} ${said}`;
}

/** What this tool's structured content is (result.ts `answerSchema`): built once, for every request. */
const OUTPUT = answerSchema({
  days: z.number().int(),
  visits: z.array(z.strictObject({
    personId: z.string(),
    name: z.string(),
    date: z.string().describe('YYYY-MM-DD, where the house is.'),
    day: z.string(),
    arrived: z.string().describe('"9:02 am".'),
    left: z.string().optional().describe('Absent when nobody was seen leaving.'),
    arrivedAt: z.number(),
    leftAt: z.number().optional(),
    confirmed: z.boolean().describe('The resident herself said this is right. False says only that she has not.'),
  })).describe('Newest first.'),
  confirmedCount: z.number().int(),
  residentName: z.string(),
  summary: z.string().describe('The whole of it in words, to be said as it stands.'),
  simulated: z.literal(true).optional().describe('A demo home’s visits: nobody made them.'),
});

export function registerGetVisits(mcpServer: McpServer, ddb: DynamoDBClient, ctx: ToolContext, now: () => number = Date.now): void {
  mcpServer.registerTool(
    'get_visits',
    {
      title: 'Visits by regular visitors, and whether the resident confirmed them',
      description:
        'The visits of the household’s regular visitors (a carer, a cleaner) over the last days: the day, the times the doorbell noted, and whether the resident has confirmed each one on their own television (`confirmed`). ' +
        'Use it for "did Maria come this week", "how long was the carer here", "has Mum confirmed Maria’s visits". Say `summary` as it stands. ' +
        'Pass `personId` from list_regular_visitors to keep to one visitor, and `days` to look further back than a week. ' +
        'A visit that is not confirmed means only that: never say or guess why. The times are what the doorbell noted, not a clinical or billing record. ' +
        'For whether someone came on one particular day, use did_visitor_come.',
      inputSchema: {
        personId: z.string().optional().describe('The visitor’s `personId` from list_regular_visitors, e.g. "maria". Leave out for every regular visitor.'),
        days: z.number().int().min(1).max(MAX_VISIT_DAYS).optional().describe(`How many days back to look, 1 to ${MAX_VISIT_DAYS}. Leave out for the last ${DEFAULT_VISIT_DAYS}.`),
      },
      outputSchema: OUTPUT,
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async (allowed, { personId, days = DEFAULT_VISIT_DAYS }: { personId?: string | undefined; days?: number | undefined }) => {
      // Who visits, by name, is hers to keep: asked first, and nothing is read if she does (§6.4).
      const policy = await loadHouseholdPolicy(ddb, ctx.householdId);
      if (!isSharedWithFamily('PRESENCE', policy)) return say(FAMILY_REFUSAL_TEXT);

      const noted = await visitsOf(ddb).recent(ctx.householdId, now() - days * DAY_MS);
      const theirs = (personId === undefined ? noted : noted.filter((visit) => visit.personId === personId)).sort((a, b) => b.arrivedAt - a.arrivedAt);
      const visits = theirs.map((visit) => forFamily(visit, HOUSEHOLD_TZ));
      const residentName = allowed.household.residentName;

      const answer: VisitsForFamily = {
        days,
        visits,
        confirmedCount: visits.filter((visit) => visit.confirmed).length,
        residentName,
        summary: visitsSummary(visits, residentName, days, personId !== undefined),
        ...(theirs.some((visit) => visit.simulated) ? { simulated: true as const } : {}),
      };
      return data(answer);
    })),
  );
}
