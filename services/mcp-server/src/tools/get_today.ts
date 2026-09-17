/**
 * MCP tool: get_today — bounded Query over the EVT# timeline. See §7.3.
 *
 * Reads the same EVT#<ts>#<ulid> entity route.mjs already writes for
 * card_shown/card_action (real, in production), extended with door/presence
 * kinds that only a seed script writes today. Deterministic formatting only —
 * no model call, matching §9.3's latency budget.
 *
 * route.mjs (services/edge-device/lambda/route.mjs) never writes a separate
 * `at` attribute on these items — the timestamp lives ONLY in the sort key,
 * as `EVT#<15-digit-zero-padded-ms>#<uuid>` (`String(deviceEvent.at).padStart(15,
 * '0')`). So `at` here is parsed back out of the sort key rather than read off
 * an item attribute that real production rows don't have.
 */
import { QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HOUSEHOLD_ID } from '../auth.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

export interface RawTimelineEvent {
  readonly type: 'card_shown' | 'card_action' | 'door' | 'presence';
  readonly cardId?: string;
  readonly action?: string;
  readonly personName?: string;
}

export function summariseEvent(event: RawTimelineEvent): string {
  switch (event.type) {
    case 'card_shown':
      return 'A card was shown on the television.';
    case 'card_action':
      return `The resident chose "${event.action}" on a card.`;
    case 'door':
      return 'Someone was at the front door.';
    case 'presence':
      return event.personName ? `${event.personName} arrived.` : 'Someone arrived.';
  }
}

export interface TodayEntry {
  readonly at: number;
  readonly summary: string;
}

/** Zero-padded to 15 digits, matching route.mjs's EVT# sort key exactly. */
function padTs(ms: number): string {
  return String(ms).padStart(15, '0');
}

/** Parses the ms timestamp embedded in an `EVT#<15-digit>#<uuid>` sort key. */
function parseTsFromSk(sk: string): number {
  const match = /^EVT#(\d{15})#/.exec(sk);
  return match ? Number(match[1]) : 0;
}

export async function loadTodayEvents(ddb: DynamoDBClient, householdId: string, now: Date): Promise<readonly TodayEntry[]> {
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const endOfDay = startOfDay + 86_400_000;

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${householdId}` },
      ':from': { S: `EVT#${padTs(startOfDay)}` },
      ':to': { S: `EVT#${padTs(endOfDay)}#￿` },
    },
  }));

  return (res.Items ?? []).map((item) => {
    const event: RawTimelineEvent = {
      type: item.type?.S as RawTimelineEvent['type'],
      ...(item.cardId?.S !== undefined && { cardId: item.cardId.S }),
      ...(item.action?.S !== undefined && { action: item.action.S }),
      ...(item.personName?.S !== undefined && { personName: item.personName.S }),
    };
    return { at: parseTsFromSk(item.sk?.S ?? ''), summary: summariseEvent(event) };
  });
}

export function registerGetToday(mcpServer: McpServer, ddb: DynamoDBClient): void {
  mcpServer.registerTool(
    'get_today',
    {
      title: "Today's events",
      description: "Returns a plain-language summary of today's household events: door activity, presence, and what showed on the television.",
      inputSchema: {},
    },
    async () => {
      const entries = await loadTodayEvents(ddb, HOUSEHOLD_ID, new Date());
      return { content: [{ type: 'text' as const, text: JSON.stringify(entries) }] };
    },
  );
}
