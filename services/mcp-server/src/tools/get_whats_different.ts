/**
 * MCP tool: get_whats_different — D1, "Something's Different" (docs/WICK.md
 * §4.4), as the family reads it: only what the resident chose to tell.
 *
 * Wick notices when a day is unlike this household's own usual
 * (services/agent rhythm/different.ts). It used to say so to whoever in the
 * family asked. Now the resident is asked first, on their own television —
 * "Shall I tell Sarah?" — and shown the very sentence (agents/tell). This
 * tool reads the answers: a difference is here once the resident pressed
 * "Tell", in the words they were shown, and not before.
 *
 * What it must never do is let silence speak. A difference still waiting
 * for an answer, and one the resident kept to themselves, are returned
 * exactly as no difference at all is — and the summary says only that
 * nothing has been told, never that nothing is different. Otherwise "Keep
 * it to myself" would itself tell the family that there was something.
 *
 * The resident's standing choices still apply on top (get_today does the
 * same): keeping the shape of the week private withholds the whole answer,
 * and a class made private since a difference was told withholds it again.
 *
 * Nothing is computed here, and no model is called: one Query of the
 * household's TELL# rows, well inside §7.3's 500 ms.
 */
import { QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { TELL_SK_PREFIX, type FactClass } from '@wick/contracts';
import type { DifferenceKind } from '@wick/agent';
import type { HouseholdPolicy } from '@wick/policy';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { FAMILY_REFUSAL_TEXT, isSharedWithFamily, loadHouseholdPolicy } from './get_resident_shared_view.js';
import { withFriendlyErrors } from './errors.js';
import { answerSchema, READS, data, say } from './result.js';
import { z } from 'zod';

const TABLE = process.env.TABLE_NAME ?? 'wick';

const DAY_MS = 86_400_000;
/** How long something told stays readable: long enough to be read by someone who looks once a week. */
const TOLD_FOR_MS = 7 * DAY_MS;

const KEPT_PRIVATE = ' That is something the resident keeps to themselves.';

export interface ToldDifference {
  /** Stable for this difference: an app can tell what it has already shown. */
  readonly id: string;
  readonly kind: DifferenceKind;
  /** The sentence the resident was shown when they were asked, word for word. */
  readonly sentence: string;
  /** The moment the difference is about. */
  readonly at: number;
  /** When the resident said to tell. */
  readonly toldAt: number;
}

export interface DifferentForFamily {
  /** What the resident asked Wick to tell, newest first. Empty says nothing about whether anything is different. */
  readonly differences: readonly ToldDifference[];
  /** How many weeks of this household's own history the newest was measured against. Absent when nothing is told. */
  readonly weeksObserved?: number;
  /** What the resident keeps private as a standing choice, in plain words. */
  readonly keptPrivate: readonly string[];
  /** The whole answer in words, to be said as it stands. */
  readonly summary: string;
}

/**
 * The family's answer, or `undefined` when the resident keeps the shape of
 * the week private — in which case nothing has been read.
 */
export async function loadWhatsDifferent(
  ddb: DynamoDBClient,
  householdId: string,
  now: Date,
  policy: HouseholdPolicy,
  residentName: string,
): Promise<DifferentForFamily | undefined> {
  if (!isSharedWithFamily('RHYTHM', policy)) return undefined;

  const doorShared = isSharedWithFamily('DOOR_EVENT', policy);
  const presenceShared = isSharedWithFamily('PRESENCE', policy);
  const keptPrivate = [
    ...(doorShared ? [] : [`When someone comes to the door.${KEPT_PRIVATE}`]),
    ...(presenceShared ? [] : [`Who visits, by name.${KEPT_PRIVATE}`]),
  ];
  const shared = (factClass: string | undefined): boolean =>
    factClass === ('PRESENCE' satisfies FactClass) ? presenceShared : factClass === ('DOOR_EVENT' satisfies FactClass) ? doorShared : false;

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: TELL_SK_PREFIX } },
  }));

  const told: (ToldDifference & { weeksObserved: number })[] = [];
  for (const row of res.Items ?? []) {
    // Only "tell". A question still open and one answered "keep" are both simply not here.
    if (row.answer?.S !== 'tell' || !shared(row.factClass?.S)) continue;
    const toldAt = Number(row.answeredAt?.N);
    const id = row.differenceId?.S;
    const sentence = row.sentence?.S;
    if (!id || !sentence || !Number.isFinite(toldAt) || now.getTime() - toldAt > TOLD_FOR_MS) continue;
    told.push({ id, kind: row.kind?.S as DifferenceKind, sentence, at: Number(row.at?.N), toldAt, weeksObserved: Number(row.weeksObserved?.N ?? 0) });
  }
  told.sort((a, b) => b.toldAt - a.toldAt);

  const differences = told.map(({ weeksObserved: _weeks, ...difference }) => difference);
  return {
    differences,
    ...(told[0] ? { weeksObserved: told[0].weeksObserved } : {}),
    keptPrivate,
    summary: differences.length === 0
      ? `${residentName} hasn't asked Wick to tell you anything.`
      : `${residentName} asked Wick to tell you: ${differences.map((d) => d.sentence).join(' ')}`,
  };
}

/** What this tool's structured content is (result.ts `answerSchema`): built once, for every request. */
const OUTPUT = answerSchema({
  differences: z.array(z.strictObject({
    id: z.string(),
    kind: z.string().optional().describe('missed_visit, door_at_night, door_quiet, door_busy or visit_disputed.'),
    sentence: z.string().describe('The sentence the resident was shown when they were asked, word for word.'),
    at: z.number(),
    toldAt: z.number(),
  })).describe('What the resident asked Wick to tell, newest first. Empty says nothing about whether anything is different.'),
  weeksObserved: z.number().optional(),
  keptPrivate: z.array(z.string()),
  summary: z.string().describe('The whole answer in words, to be said as it stands.'),
});

export function registerGetWhatsDifferent(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  now: () => Date = () => new Date(),
): void {
  mcpServer.registerTool(
    'get_whats_different',
    {
      title: 'What the resident asked to be told',
      description:
        "Wick notices when a day is unlike this household's own usual: a regular visitor who did not come, somebody at the door in the night, a day at the door unlike the same weekday usually is. " +
        'It asks the resident first, on their television, whether to tell the family. This returns only what the resident said to tell, each in the one sentence they were shown, newest first. ' +
        'Use it for "is anything different", "is everything all right" or "anything I should know". Say `summary` as it stands. ' +
        'An empty answer means nothing has been told — it does NOT mean nothing is different, so never say that nothing is different, that all is well, or that anything is being kept back. It is not an alert and must not be told as one.',
      inputSchema: {},
      outputSchema: OUTPUT,
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async (allowed) => {
      const policy = await loadHouseholdPolicy(ddb, ctx.householdId);
      const answer = await loadWhatsDifferent(ddb, ctx.householdId, now(), policy, allowed.household.residentName);
      return answer ? data(answer) : say(FAMILY_REFUSAL_TEXT);
    })),
  );
}
