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
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HOUSEHOLD_ID } from '../auth.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

export async function loadHouseholdPolicy(ddb: DynamoDBClient, householdId: string): Promise<HouseholdPolicy> {
  const res = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: 'META' } },
  }));
  const raw = res.Item?.policy?.S;
  return raw ? (JSON.parse(raw) as HouseholdPolicy) : DEFAULT_POLICY;
}

export function registerGetResidentSharedView(mcpServer: McpServer, ddb: DynamoDBClient): void {
  mcpServer.registerTool(
    'get_resident_shared_view',
    {
      title: 'What the resident shares with family',
      description: "Returns exactly what the resident has agreed is shared with family — the machine-readable counterpart of the television's \"What Sarah Sees\" screen.",
      inputSchema: {},
    },
    async () => {
      const policy = await loadHouseholdPolicy(ddb, HOUSEHOLD_ID);
      const shared = (Object.keys(policy.table) as (keyof typeof policy.table)[])
        .filter((factClass) => {
          const rule = policy.table[factClass].FAMILY;
          return rule.allow || policy.familyPermitted.includes(factClass);
        })
        .filter((factClass) => !policy.residentExclusions.includes(factClass));
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ sharedWithFamily: shared, residentExclusions: policy.residentExclusions }),
          },
        ],
      };
    },
  );
}
