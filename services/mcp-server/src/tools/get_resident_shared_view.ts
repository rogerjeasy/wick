/**
 * MCP tool: get_resident_shared_view
 *
 * Returns exactly what the resident has agreed is shared — the machine-readable
 * counterpart of the "What Sarah Sees" screen on the television. A family member
 * can always ask what they are and are not able to see.
 *
 * Single GetItem over the household's policy record. No model call.
 */
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { isSharedWithFamily, loadHouseholdPolicy as loadPolicyFrom } from '@wick/agent';
import type { HouseholdPolicy } from '@wick/policy';
import type { FactClass } from '@wick/contracts';
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
 * television merged in — read as the agent plane reads it
 * (services/agent store/household.ts), so the two cannot disagree.
 */
export const loadHouseholdPolicy = (ddb: DynamoDBClient, householdId: string): Promise<HouseholdPolicy> =>
  loadPolicyFrom(ddb, TABLE, householdId);

/** The single source of truth for "is this FactClass visible to FAMILY" (services/agent store/household.ts). */
export { isSharedWithFamily };

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
