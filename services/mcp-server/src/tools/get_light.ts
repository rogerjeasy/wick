/**
 * MCP tool: get_light — the light in the window
 * (packages/contracts/src/light.ts).
 *
 * One thing about today, and nothing else: whether the resident's light is
 * lit. It is lit once a television in the home has been in use today, and
 * not when the resident has put it out for the day.
 *
 * What it must never do:
 *
 *   - say more than lit or not: no time, no count, no room, no programme;
 *   - tell "she put it out" from "not lit yet". Both are one answer, in the
 *     same words, so an unlit window never says why — otherwise putting it
 *     out would itself tell the family something;
 *   - answer at all when the resident keeps the shape of her week private.
 *
 * Asking is a look, and the resident is told who looked in (lookIn.ts); the
 * answer says so to the person asking.
 *
 * Nothing is computed beyond that: one Query of the household's television
 * rows and one GetItem, well inside §7.3's 500 ms.
 */
import { GetItemCommand, QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LIGHT_SK, isLit } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { FAMILY_REFUSAL_TEXT, isSharedWithFamily, loadHouseholdPolicy } from './get_resident_shared_view.js';
import { withFriendlyErrors } from './errors.js';
import { answerSchema, READS, data, say } from './result.js';
import { z } from 'zod';
import { zoneOf } from '../accounts/types.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

export interface LightForFamily {
  readonly lit: boolean;
  /** The whole answer in words, to be said as it stands. */
  readonly summary: string;
  /** That the resident is told of this look. */
  readonly seen: string;
}

/** When each of the home's televisions last said someone was at it (edge-device television-active.mjs). */
async function activeAts(ddb: DynamoDBClient, householdId: string): Promise<number[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: 'DEV#' } },
  }));
  return (res.Items ?? []).map((item) => Number(item.activeSignalAt?.N)).filter(Number.isFinite);
}

export async function loadLight(ddb: DynamoDBClient, householdId: string, now: number, residentName: string, timeZone: string): Promise<LightForFamily> {
  const [ats, light] = await Promise.all([
    activeAts(ddb, householdId),
    ddb.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: `HH#${householdId}` }, sk: { S: LIGHT_SK } } })),
  ]);
  const outAt = Number(light.Item?.outAt?.N);
  const lit = isLit({ activeAts: ats, ...(Number.isFinite(outAt) ? { outAt } : {}), now, timeZone });
  return {
    lit,
    summary: lit
      ? `The light is on at ${residentName}’s: the day has begun there.`
      : `The light isn’t on at ${residentName}’s. It may not be lit yet today, or ${residentName} may have put it out.`,
    seen: `${residentName} can see that you looked in.`,
  };
}

/** What this tool's structured content is (result.ts `answerSchema`): built once, for every request. */
const OUTPUT = answerSchema({
  lit: z.boolean(),
  summary: z.string().describe('The whole answer in words, to be said as it stands.'),
  seen: z.string().describe('That the resident is told of this look.'),
});

export function registerGetLight(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  now: () => number = Date.now,
): void {
  mcpServer.registerTool(
    'get_light',
    {
      title: 'The light in the window',
      description:
        "Whether the resident's light is lit: one thing about today, and nothing else. It is lit once the resident's day has begun at home, and the resident can put it out for the day. " +
        'Use it for "is the light on", "is Mum up", "has her day started" or a quick "is everything as usual this morning". Say `summary` as it stands, then `seen`. ' +
        'A light that is not lit does NOT mean anything is wrong and does NOT mean the resident is not up: it may not be lit yet, or the resident may have put it out, and the two cannot be told apart — so never say which, and never guess. ' +
        'It carries no time, and must not be told as one. The resident is shown who looked in.',
      inputSchema: {},
      outputSchema: OUTPUT,
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async (allowed) => {
      const policy = await loadHouseholdPolicy(ddb, ctx.householdId);
      if (!isSharedWithFamily('RHYTHM', policy)) return say(FAMILY_REFUSAL_TEXT);
      return data(await loadLight(ddb, ctx.householdId, now(), allowed.household.residentName, zoneOf(allowed.household)));
    }, { looksIn: true })),
  );
}
