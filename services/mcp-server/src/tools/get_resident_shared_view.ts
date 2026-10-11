/**
 * MCP tool: get_resident_shared_view
 *
 * Returns exactly what the resident has agreed is shared — the machine-readable
 * counterpart of the "What Sarah Sees" screen on the television. A family member
 * can always ask what they are and are not able to see.
 *
 * Single GetItem over the household's policy record. No model call.
 */
import { GetItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { HouseholdPolicy } from '@wick/policy';
import { DEFAULT_POLICY } from '@wick/policy';
import { NEVER_TO_FAMILY, type FactClass } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { READS, data } from './result.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

/**
 * Refusals are a product feature, not an error path — warm, specific, never
 * silent (§6.4: silence is indistinguishable from "nothing happened", which
 * is a lie). Mirrors services/policy/src/evaluate.ts's `defaultRefusal`
 * FAMILY-audience phrasing exactly, for the tools in this directory that
 * withhold data directly rather than going through the Guardian's `evaluate`.
 */
export const FAMILY_REFUSAL_TEXT = "That's something the resident is keeping to themselves. I'm not able to share it.";

/**
 * The household's policy, with the resident's own choices from their
 * television merged in. "What Sarah sees" (services/edge-device/lambda/
 * sharing.mjs) records those as a `residentExclusions` string set on this
 * same META item, so the policy document itself is never rewritten by a
 * device. Exclusions only ever narrow (services/policy).
 */
export async function loadHouseholdPolicy(ddb: DynamoDBClient, householdId: string): Promise<HouseholdPolicy> {
  const res = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: 'META' } },
  }));
  const raw = res.Item?.policy?.S;
  const policy = raw ? (JSON.parse(raw) as HouseholdPolicy) : DEFAULT_POLICY;
  const fromTv = (res.Item?.residentExclusions?.SS ?? []) as FactClass[];
  if (fromTv.length === 0) return policy;
  return { ...policy, residentExclusions: [...new Set([...policy.residentExclusions, ...fromTv])] };
}

/**
 * Mirrors services/policy/src/evaluate.ts's order exactly: table rule allows
 * it, OR it's an explicit opt-in that is not in NEVER_TO_FAMILY (the opt-in
 * can never widen past that hard cap); resident exclusions narrow last. The
 * single source of truth for "is this FactClass visible to FAMILY" used by
 * get_resident_shared_view, get_today and did_visitor_come alike, so all
 * three surfaces can never disagree.
 */
export function isSharedWithFamily(factClass: FactClass, policy: HouseholdPolicy): boolean {
  const rule = policy.table[factClass].FAMILY;
  const allowed =
    rule.allow || (policy.familyPermitted.includes(factClass) && !NEVER_TO_FAMILY.includes(factClass));
  return allowed && !policy.residentExclusions.includes(factClass);
}

/**
 * Each class in the words the television's own "What Sarah sees" screen
 * uses for it. Sent with the codes, because a code read cold is guessed
 * at: an assistant shown PRESENCE told someone the resident shares
 * "whether she is in or out" — it means who visits, by name.
 */
export const FACT_CLASS_WORDS: Readonly<Record<FactClass, string>> = {
  DOOR_EVENT: 'When someone comes to the door',
  PRESENCE: 'Who visits, by name',
  COMMITMENT: 'Appointments and plans',
  RHYTHM: 'The shape of the week',
  HEALTH: 'Health',
  FINANCIAL: 'Money',
  RELATIONSHIP: 'Relationships',
  LOCATION: 'Where they go',
  VERBATIM: 'What was said, word for word',
};

export function registerGetResidentSharedView(mcpServer: McpServer, ddb: DynamoDBClient, ctx: ToolContext): void {
  mcpServer.registerTool(
    'get_resident_shared_view',
    {
      title: 'What the resident shares with family',
      description:
        "Returns exactly what the resident has agreed is shared with family — the counterpart of the television's \"What Sarah Sees\" screen. " +
        'Use `sharedInWords` and `keptPrivateInWords` when saying it: they are what each kind of thing means.',
      inputSchema: {},
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async () => {
      const policy = await loadHouseholdPolicy(ddb, ctx.householdId);
      const shared = (Object.keys(policy.table) as FactClass[]).filter((factClass) =>
        isSharedWithFamily(factClass, policy),
      );
      return data({
        sharedWithFamily: shared,
        residentExclusions: policy.residentExclusions,
        sharedInWords: shared.map((c) => FACT_CLASS_WORDS[c]),
        keptPrivateInWords: policy.residentExclusions.map((c) => FACT_CLASS_WORDS[c]),
      });
    })),
  );
}
