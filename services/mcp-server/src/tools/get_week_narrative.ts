/**
 * MCP tool: get_week_narrative — single GetItem over precomputed state. See §7.3.
 *
 * INV-7: the resident sees their week before the family can read it.
 * `residentSeenAt` gates readability here, not just on write. A narrative
 * that exists but hasn't been seen on the television yet is withheld, and
 * the family is told why, in so many words (§6.4: refusal is a feature,
 * never silence, never a lie). That sentence is the trust model, said out
 * loud, so it is kept apart from the plainer "no week written yet".
 *
 * With no week named — the overwhelmingly common case, "how's Mum been
 * this week?" — the answer is the latest week the resident has read. The
 * week is written on Sunday evening, so for six days in seven the current
 * week has no story yet; answering "not yet" all that time made the one
 * thing Wick is for unreachable. The answer says which week it is, and
 * what has become of the current one (`thisWeek`), so no client can pass
 * last week off as this one. INV-7 is unchanged: a week still waiting on
 * the television is stepped over, never read out.
 */
import { z } from 'zod';
import { GetItemCommand, QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SUGGESTED_ACTIONS, currentIsoWeek, doorWhenExpected, type RhythmDelta, type TimelineEntry, type WeekNarrative } from '@wick/contracts';
import type { HouseholdPolicy } from '@wick/policy';
import { fallbackNarrative, isoWeekRange, privateNarrative, summariseWeek, visibleDeltas } from '@wick/agent';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { FAMILY_REFUSAL_TEXT, isSharedWithFamily, loadHouseholdPolicy } from './get_resident_shared_view.js';
import { answerSchema, READS, data, say } from './result.js';
import { clears } from '../guardian.js';
import { zoneOf } from '../accounts/types.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

export type WeekNarrativeResult =
  | { readonly status: 'available'; readonly narrative: WeekNarrative }
  | { readonly status: 'awaiting_resident' }
  | { readonly status: 'not_written' };

export const WEEK_AWAITING_RESIDENT_TEXT =
  "This week's story is written, and it's on the television now. The person it's about reads it first. It's yours to read once they have.";
export const WEEK_NOT_WRITTEN_TEXT = "There's no story for this week yet. Wick writes the week on Sunday evening.";
/** For a week asked for by name: it is not "this week", and Sunday evening will not bring it. */
export const WEEK_NOT_WRITTEN_THEN_TEXT = "There's no story for that week.";

/** What has become of the current week, when the week returned is an earlier one. */
export type ThisWeekStatus = 'not_written' | 'awaiting_resident';

export type LatestWeekResult =
  | { readonly status: 'available'; readonly narrative: WeekNarrative; readonly thisWeek?: ThisWeekStatus }
  | { readonly status: 'awaiting_resident' }
  | { readonly status: 'not_written' };

/**
 * The latest week the resident has read, from the household's newest
 * weeks (newest first, none later than `currentWeek`). Pure: the rule is
 * tested without a table.
 */
export function latestReadableWeek(newestFirst: readonly WeekNarrative[], currentWeek: string): LatestWeekResult {
  const current = newestFirst.find((n) => n.isoWeek === currentWeek);
  if (current?.residentSeenAt !== undefined) return { status: 'available', narrative: current };

  const earlier = newestFirst.find((n) => n.isoWeek < currentWeek && n.residentSeenAt !== undefined);
  if (earlier) return { status: 'available', narrative: earlier, thisWeek: current ? 'awaiting_resident' : 'not_written' };
  return { status: newestFirst.length ? 'awaiting_resident' : 'not_written' };
}

/** How far back to look for a week that has been read. Two months of unread weeks is not a home using Wick. */
const WEEKS_TO_LOOK_BACK = 8;

export async function loadLatestWeek(ddb: DynamoDBClient, householdId: string, currentWeek: string): Promise<LatestWeekResult> {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${householdId}` },
      ':from': { S: 'NARR#' },
      ':to': { S: `NARR#${currentWeek}` },
    },
    ScanIndexForward: false,
    Limit: WEEKS_TO_LOOK_BACK,
  }));
  const weeks = (res.Items ?? []).flatMap((item) => (item.data?.S ? [JSON.parse(item.data.S) as WeekNarrative] : []));
  return latestReadableWeek(weeks, currentWeek);
}

export async function loadWeekNarrative(
  ddb: DynamoDBClient,
  householdId: string,
  isoWeek: string,
): Promise<WeekNarrativeResult> {
  const res = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `NARR#${isoWeek}` } },
  }));
  const raw = res.Item?.data?.S;
  if (!raw) return { status: 'not_written' };
  const narrative = JSON.parse(raw) as WeekNarrative;
  if (narrative.residentSeenAt === undefined) return { status: 'awaiting_resident' };
  return { status: 'available', narrative };
}

export type FamilyWeekResult =
  | { readonly status: 'available'; readonly narrative: WeekNarrative }
  | { readonly status: 'private' };

/** Whether the gate cannot clear a timeline entry: its sentence, or the id its visitor's name makes. */
const entryIsUnclear = (e: TimelineEntry, people: readonly string[]): boolean =>
  !clears(e.summary, people) || (e.personId !== undefined && !clears(e.personId, people)) || (e.name !== undefined && !clears(e.name, people));

/** A comparison names its visitor twice: as a label, and in its metric (`visit:<personId>`). */
const deltaIsUnclear = (d: RhythmDelta, people: readonly string[]): boolean =>
  !clears(d.metric, people) || (d.label !== undefined && !clears(d.label, people));

/**
 * Whether the gate cannot clear something in this week as it stands: the
 * paragraph, an entry, a comparison. Given the household's own people
 * (people.ts), a name in another script is not that something.
 */
export function weekIsUnclear(narrative: WeekNarrative, people: readonly string[] = []): boolean {
  return !clears(narrative.text, people) || narrative.timeline.some((e) => entryIsUnclear(e, people)) || (narrative.deltas ?? []).some((d) => deltaIsUnclear(d, people));
}

/**
 * The household's people, but only when this week would otherwise be held
 * back or rewritten: the common week costs no read.
 */
export async function namesForWeek(narrative: WeekNarrative, people: (() => Promise<readonly string[]>) | undefined): Promise<readonly string[]> {
  if (!people || !weekIsUnclear(narrative)) return [];
  return people().catch(() => []);
}

/**
 * Sarah's copy of the week, honouring what the resident keeps private
 * ("What Sarah sees", services/edge-device/lambda/sharing.mjs). The week's
 * summary is itself the RHYTHM class, so keeping that private withholds the
 * whole week. Keeping door visits or visitors private drops those entries
 * from the timeline and rewrites the prose from the facts still shared;
 * the stored prose may mention them, and the model is never asked again
 * in-request (§9.3: the round trip stays a GetItem or two). The Rhythm
 * comparisons go the same way: a private door takes "more callers than
 * usual" with it, and private visitors take "Maria did not visit" — an
 * absence is as much a fact about someone as an arrival.
 *
 * And the Guardian reads the week (INV-4). The paragraph is a model's, and
 * a timeline entry carries a visitor's name as the family typed it ("Dr
 * Patel visited."). A paragraph the gate cannot clear is rewritten from the
 * week's counts, in the words the Narrator uses when its model fails — a
 * week that already happens, and that says nothing was held back. An entry
 * or a comparison it cannot clear is left out, and out of those counts. The
 * resident's own television keeps the week as it was written: she has seen
 * everything the family reads, and more.
 */
/** How a week written before 2026-10-20 said somebody at the door when a visitor was expected. */
const LEGACY_VISITED = /^(.+) visited\.$/;

/**
 * A week stored before the door and a confirmed visit were told apart: its
 * `visit` entries were somebody at the door when the visitor was expected,
 * written "Maria visited." They are read as what they were, and the week's
 * text, which may say the same, is written again from the facts.
 */
export function upgradeLegacyWeek(narrative: WeekNarrative): { readonly narrative: WeekNarrative; readonly upgraded: boolean } {
  let upgraded = false;
  const timeline = narrative.timeline.map((entry): TimelineEntry => {
    const name = entry.kind === 'visit' && entry.name === undefined ? LEGACY_VISITED.exec(entry.summary)?.[1] : undefined;
    if (name === undefined) return entry;
    upgraded = true;
    return { ...entry, kind: 'presence', summary: name === 'Someone' ? 'Someone came to the door when a regular visitor was expected.' : doorWhenExpected(name), ...(name === 'Someone' ? {} : { name }) };
  });
  return upgraded ? { narrative: { ...narrative, timeline }, upgraded } : { narrative, upgraded };
}

export function familyWeek(stored: WeekNarrative, policy: HouseholdPolicy, timeZone: string, people: readonly string[] = []): FamilyWeekResult {
  if (!isSharedWithFamily('RHYTHM', policy)) return { status: 'private' };

  const { narrative, upgraded } = upgradeLegacyWeek(stored);
  const hidden = { door: !isSharedWithFamily('DOOR_EVENT', policy), visits: !isSharedWithFamily('PRESENCE', policy) };
  const unclearEntry = (e: TimelineEntry) => entryIsUnclear(e, people);
  const unclearDelta = (d: RhythmDelta) => deltaIsUnclear(d, people);
  const unclear = weekIsUnclear(narrative, people);
  if (!hidden.door && !hidden.visits && !unclear && !upgraded) {
    // The Sunday brief's suggestion is read like everything else: one the gate cannot clear is left out, never reworded.
    if (narrative.suggestion && !clears(narrative.suggestion.reason, people)) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'guardian_withheld', where: 'week_suggestion', isoWeek: narrative.isoWeek }));
      const { suggestion: _withheld, ...rest } = narrative;
      return { status: 'available', narrative: rest };
    }
    return { status: 'available', narrative };
  }
  if (unclear) console.warn(JSON.stringify({ level: 'warn', msg: 'guardian_withheld', where: 'week', isoWeek: narrative.isoWeek }));

  const hides = (kind: string) => (kind === 'door' && hidden.door) || ((kind === 'visit' || kind === 'presence') && hidden.visits);
  const timeline = narrative.timeline.filter((e) => !hides(e.kind) && !unclearEntry(e));
  const facts = summariseWeek(timeline, { timeZone, range: isoWeekRange(narrative.isoWeek), now: narrative.generatedAt, unheardDays: narrative.unheardDays ?? [] });
  // Weeks written before the baseline existed carry no deltas at all.
  const deltas = visibleDeltas(narrative.deltas ?? [], hidden).filter((d) => !unclearDelta(d));
  // Only her own choice is said to be kept private: what the Guardian held back is not mentioned at all.
  const text = hidden.door || hidden.visits ? privateNarrative(facts, hidden, deltas) : fallbackNarrative(facts, deltas);
  // The suggestion rested on the whole week, so it goes with the paragraph: the family's copy is the facts they may read, and no more.
  // Which days the doorbell went unheard is about the door: kept back with it.
  const { suggestion: _rested, unheardDays: _unheard, ...kept } = narrative;
  const rest = hidden.door || !narrative.unheardDays?.length ? kept : { ...kept, unheardDays: narrative.unheardDays };
  return {
    status: 'available',
    narrative: { ...rest, timeline, deltas, text, textSource: 'facts' },
  };
}

/** Words a week uses about itself, and what they become once it is an earlier week. Longest first. */
const SPOKEN_FROM_THEN: readonly (readonly [RegExp, string])[] = [
  [/\bso far this week\b/gi, 'that week'],
  [/\bthis week\b/gi, 'that week'],
  [/\blast week\b/gi, 'the week before'],
  [/\bnext week\b/gi, 'the week after'],
];

/**
 * A sentence written about its own week, said once that week is over and
 * another has begun. The Sunday brief writes "this week", meaning the week it
 * is about; read out on a Wednesday under "Here is the week of 5 October",
 * "6 times this week" says the opposite of the line above it. Only those
 * words change — no number, name or claim — so what the Guardian and the
 * Guardrail cleared is still what is read. A capital stays a capital.
 */
export function spokenFromThen(text: string): string {
  return SPOKEN_FROM_THEN.reduce(
    (said, [words, then]) => said.replace(words, (found) => (found[0] === found[0]?.toUpperCase() ? then[0]!.toUpperCase() + then.slice(1) : then)),
    text,
  );
}

/** The family's copy of an earlier week, its prose and its suggestion's reason said from now (`spokenFromThen`). */
export function asAnEarlierWeek(narrative: WeekNarrative): WeekNarrative {
  return {
    ...narrative,
    text: spokenFromThen(narrative.text),
    ...(narrative.suggestion ? { suggestion: { ...narrative.suggestion, reason: spokenFromThen(narrative.suggestion.reason) } } : {}),
  };
}

/** What "the latest week" is for the family: the week as they may read it, or why there is none for them. */
export type FamilyLatestWeek =
  | { readonly status: 'available'; readonly narrative: WeekNarrative; readonly thisWeek?: ThisWeekStatus }
  | { readonly status: 'awaiting_resident' }
  | { readonly status: 'not_written' }
  | { readonly status: 'private' };

/**
 * The latest week the family may read, as the tool gives it when no week is
 * named: one the resident has read (INV-7), in the family's copy of it
 * (familyWeek). A family member's own television asks the same question
 * through this (accounts/familyTelevision.ts), so the two cannot disagree.
 * `policy` is asked for only when there is a week to apply it to.
 */
export async function loadLatestFamilyWeek(
  ddb: DynamoDBClient,
  householdId: string,
  currentWeek: string,
  policy: () => Promise<HouseholdPolicy>,
  timeZone: string,
  /** The household's own people, asked for only when the week would otherwise be held back (people.ts). */
  people?: () => Promise<readonly string[]>,
): Promise<FamilyLatestWeek> {
  const latest = await loadLatestWeek(ddb, householdId, currentWeek);
  return latest.status === 'available' ? familyCopyOfLatest(latest, await policy(), timeZone, await namesForWeek(latest.narrative, people)) : latest;
}

/**
 * The family's copy of a latest week already looked up: what the resident
 * shares, applied now. Pure, so a caller that keeps the lookup for a moment
 * (a television asking every few seconds) still applies her choices as they
 * stand on every asking, never as they stood.
 */
export function familyCopyOfLatest(latest: LatestWeekResult, policy: HouseholdPolicy, timeZone: string, people: readonly string[] = []): FamilyLatestWeek {
  if (latest.status !== 'available') return latest;
  const family = familyWeek(latest.narrative, policy, timeZone, people);
  if (family.status === 'private') return { status: 'private' };
  // An earlier week than the current one is said as one: "that week", never "this week".
  if (latest.thisWeek) return { status: 'available', narrative: asAnEarlierWeek(family.narrative), thisWeek: latest.thisWeek };
  return { status: 'available', narrative: family.narrative };
}

/**
 * The week as this tool gives it, field by field. A stored week is JSON
 * read back from its row: a field added to the row later must not reach
 * the family by being carried along, nor break the tool's output schema.
 */
export function weekAnswer(week: WeekNarrative, thisWeek?: ThisWeekStatus) {
  return {
    householdId: week.householdId,
    isoWeek: week.isoWeek,
    text: week.text,
    ...(week.textSource === undefined ? {} : { textSource: week.textSource }),
    ...(week.suggestion === undefined ? {} : { suggestion: { action: week.suggestion.action, reason: week.suggestion.reason } }),
    deltas: (week.deltas ?? []).map((d) => ({
      metric: d.metric,
      ...(d.label === undefined ? {} : { label: d.label }),
      thisWeek: d.thisWeek,
      ...(d.lastWeek === undefined ? {} : { lastWeek: d.lastWeek }),
      baseline: d.baseline,
      zScore: d.zScore,
      baselineWeeks: d.baselineWeeks,
      ...(d.verdict === undefined ? {} : { verdict: d.verdict }),
    })),
    timeline: week.timeline.map((e) => ({ at: e.at, kind: e.kind, summary: e.summary, ...(e.personId === undefined ? {} : { personId: e.personId }), ...(e.name === undefined ? {} : { name: e.name }) })),
    ...(week.unheardDays?.length ? { unheardDays: [...week.unheardDays] } : {}),
    generatedAt: week.generatedAt,
    ...(week.residentSeenAt === undefined ? {} : { residentSeenAt: week.residentSeenAt }),
    ...(week.simulated ? { simulated: true as const } : {}),
    ...(thisWeek ? { thisWeek } : {}),
  };
}

/** What this tool's structured content is (result.ts `answerSchema`): built once, for every request. */
const OUTPUT = answerSchema({
  householdId: z.string(),
  isoWeek: z.string().describe('"2026-W41".'),
  text: z.string().describe('The week in words.'),
  textSource: z.enum(['model', 'facts', 'agents']).optional().describe('"agents": written by the Sunday brief, Wick\'s agents on AgentCore.'),
  suggestion: z
    .strictObject({ action: z.enum(SUGGESTED_ACTIONS), reason: z.string() })
    .optional()
    .describe('The Sunday brief\'s one thing the family member could do about the week: send_note, arrange_visit, watch_together, or nothing.'),
  deltas: z.array(z.strictObject({
    metric: z.string(),
    label: z.string().optional(),
    thisWeek: z.number(),
    lastWeek: z.number().optional(),
    baseline: z.number(),
    zScore: z.number(),
    baselineWeeks: z.number(),
    verdict: z.enum(['usual', 'more', 'fewer']).optional(),
  })),
  timeline: z.array(z.strictObject({
    at: z.number(),
    kind: z.enum(['door', 'presence', 'visit', 'card', 'deviation']),
    summary: z.string(),
    personId: z.string().optional(),
    name: z.string().optional().describe('The regular visitor a `presence` (someone at the door when they were expected) or `visit` (confirmed by the resident) entry is about.'),
  })),
  unheardDays: z.array(z.string()).optional().describe('Days of the week the doorbell was not heard at all: nothing can be said of who came then, and the week is not called quiet.'),
  generatedAt: z.number(),
  residentSeenAt: z.number().optional(),
  simulated: z.literal(true).optional().describe('A demo home’s week: nobody lived it.'),
  thisWeek: z.enum(['not_written', 'awaiting_resident']).optional().describe('Set when the week given is not the current one: what has become of the current one.'),
});

export function registerGetWeekNarrative(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  now: () => Date = () => new Date(),
): void {
  mcpServer.registerTool(
    'get_week_narrative',
    {
      title: 'The week’s narrative',
      description:
        "Returns the household's weekly narrative: prose, a timeline, and how the week compares with a usual one (`deltas`). " +
        'With no week named, returns the most recent week the resident has already read on their own television; ' +
        '`thisWeek` is then set when that is not the current week ("not_written": Wick writes the week on Sunday evening; ' +
        '"awaiting_resident": it is on the television, and they read it first). ' +
        "Never returns a week the resident hasn't seen yet. " +
        'A week written by Wick\'s agents (the Sunday brief) carries `suggestion`: one thing the family member could do about it, under the same rule.',
      inputSchema: { isoWeek: z.string().optional().describe('ISO 8601 week, e.g. "2026-W38", for that exact week. Leave out for the latest week there is to read.') },
      outputSchema: OUTPUT,
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async (allowed, { isoWeek }: { isoWeek?: string | undefined }) => {
      const timeZone = zoneOf(allowed.household);
      const currentWeek = currentIsoWeek(now());
      const policy = (): Promise<HouseholdPolicy> => loadHouseholdPolicy(ddb, ctx.householdId);
      let result: FamilyLatestWeek;
      if (isoWeek) {
        const named = await loadWeekNarrative(ddb, ctx.householdId, isoWeek);
        result = named.status === 'available' ? familyWeek(named.narrative, await policy(), timeZone, await namesForWeek(named.narrative, ctx.people)) : named;
        // A week named that is over is said as one, like the latest week when it is an earlier one.
        if (result.status === 'available' && isoWeek < currentWeek) result = { status: 'available', narrative: asAnEarlierWeek(result.narrative) };
      } else {
        result = await loadLatestFamilyWeek(ddb, ctx.householdId, currentWeek, policy, timeZone, ctx.people);
      }

      if (result.status === 'awaiting_resident') return say(WEEK_AWAITING_RESIDENT_TEXT);
      if (result.status === 'not_written') {
        return say(isoWeek && isoWeek !== currentWeek ? WEEK_NOT_WRITTEN_THEN_TEXT : WEEK_NOT_WRITTEN_TEXT);
      }
      if (result.status === 'private') return say(FAMILY_REFUSAL_TEXT);
      return data(weekAnswer(result.narrative, result.thisWeek));
    }, { looksIn: true })),
  );
}
